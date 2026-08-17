/**
 * delivery — Oh My Pi extension core.
 *
 * Registers a `session_stop` hook that:
 *   1. skips in TUI mode unless enable_tui_review is enabled (FR-014); when
 *      enabled, the TUI review runs ASYNCHRONOUSLY in the background and
 *      never blocks session_stop,
 *   2. silences short repeated stops until enough new assistant turns exist
 *      (FR-018, min_assistant_turns_increment),
 *   3. skips when context budget is exceeded (FR-011, fail-open),
 *   4. packages the most recent messages (plaintext evidence + archive),
 *   5. archives the raw window via appendEntry("delivery.archive", …) (FR-003),
 *   6. resolves the review model (FR-012, fail-open),
 *   7. runs an isolated read-only review subprocess (FR-005/FR-013, fail-open),
 *   8. decides done/continue/need_user (FR-007/FR-008/FR-009/FR-010).
 *
 * Every outcome writes appendEntry("delivery.review", …) + logs (AC-001).
 * All side-channel calls (appendEntry/notify/logger) are wrapped so failures
 * never throw out of the handler.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "./src/config.ts";
import type { DeliveryConfig } from "./src/config.ts";
import { packageMessages } from "./src/package.ts";
import { OMP_BIN, buildReviewPrompt, runReview } from "./src/reviewer.ts";
import type { ReviewOutcome } from "./src/reviewer.ts";
import { decide } from "./src/decide.ts";
import type {
  ContextUsage,
  ContinueResponse,
  CustomMessagePayload,
  DeliveryCtx,
  DeliveryPi,
  ExtensionAPI,
  SessionStopEvent,
} from "./src/types.ts";

/** FR-014: TUI form (ctx.hasUI === true) -> no auto review/continue. */
export function isTui(ctx: DeliveryCtx): boolean {
  return !!ctx && ctx.hasUI === true;
}

/** FR-011: skip review when context usage exceeds the trigger budget. */
export function overBudget(
  usage: ContextUsage,
  cfg: Pick<DeliveryConfig, "max_trigger_percent" | "max_trigger_tokens">,
): boolean {
  if (typeof usage.percent === "number" && Number.isFinite(usage.percent)) {
    return usage.percent > cfg.max_trigger_percent;
  }
  return usage.tokens > cfg.max_trigger_tokens;
}

/**
 * FR-012: turn a resolved model into a model id for `--model`.
 * Accepts a string or an object with an id/name/model field. Returns null when
 * resolution produced nothing usable (fail-open, no fallback).
 */
export function toModelId(resolved: unknown): string | null {
  if (typeof resolved === "string" && resolved.trim()) return resolved.trim();
  if (resolved && typeof resolved === "object") {
    const o = resolved as Record<string, unknown>;
    const provider = o.provider;
    const id = o.id;
    if (
      typeof provider === "string" &&
      provider.trim() &&
      typeof id === "string" &&
      id.trim()
    ) {
      const trimmedId = id.trim();
      return trimmedId.includes("/") ? trimmedId : `${provider.trim()}/${trimmedId}`;
    }
    for (const key of ["id", "name", "model", "spec"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Read ./config.json next to this module; fall back to defaults on any error. */
export function loadFileConfig(): DeliveryConfig {
  try {
    const url = new URL("./config.json", import.meta.url);
    const raw: unknown = JSON.parse(readFileSync(url, "utf8"));
    return loadConfig(raw);
  } catch {
    return loadConfig(null);
  }
}

const REVIEW_DISPLAY_LABELS: Record<string, string> = {
  done: "评审完成",
  continue: "评审：继续",
  need_user: "需要你确认",
  fail: "评审失败",
  skip: "评审跳过",
};

const REVIEW_DISPLAY_COLORS: Record<string, string> = {
  done: "success",
  continue: "accent",
  need_user: "warning",
  fail: "error",
  skip: "muted",
};

/**
 * Skip-status reasons are machine-readable English enums in `details.reason`
 * (tui / budget / no_user_input / model_resolve / …); the visible message
 * renders them as Chinese labels. Unknown reasons pass through unchanged.
 * done/continue/need_user/fail reasons are review-model Chinese text and are
 * never mapped.
 */
const SKIP_REASON_LABELS: Record<string, string> = {
  tui: "TUI 模式未启用评审",
  budget: "上下文预算超限，跳过评审",
  no_user_input: "会话中没有用户输入，无法评审",
  model_resolve: "评审模型解析失败",
};

function skipReasonLabel(reason: string): string {
  return SKIP_REASON_LABELS[reason] ?? reason;
}

export function buildReviewDisplayMessage(
  fields: Record<string, unknown>,
): CustomMessagePayload {
  const status = String(fields.status ?? "unknown");
  const label = REVIEW_DISPLAY_LABELS[status] ?? "评审";
  const rawReason = fields.reason == null ? "" : String(fields.reason);
  const reason = status === "skip" ? skipReasonLabel(rawReason) : rawReason;
  const summary = fields.summary == null ? "" : String(fields.summary);
  const head = `[delivery] ${label}${reason ? `：${reason}` : ""}`;
  const content = summary ? `${head}\n${summary}` : head;
  return {
    customType: "delivery.review",
    content,
    display: true,
    attribution: "agent",
    details: { ...fields },
  };
}

export interface ReviewMessageTheme {
  fg(color: string, text: string): string;
}

export function createReviewMessageRenderer() {
  return (
    message: unknown,
    opts: { expanded?: boolean },
    theme: ReviewMessageTheme,
  ) => {
    const m = message as { details?: Record<string, unknown>; content?: unknown };
    const details = m?.details ?? {};
    const status = String(details.status ?? "unknown");
    const label = REVIEW_DISPLAY_LABELS[status] ?? "评审";
    const color = REVIEW_DISPLAY_COLORS[status] ?? "accent";
    const rawReason = details.reason == null ? "" : String(details.reason);
    const reason = status === "skip" ? skipReasonLabel(rawReason) : rawReason;
    const summary = details.summary == null ? "" : String(details.summary);
    const clip = (s: string, width: number): string => {
      const max = Math.max(1, width);
      return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 3))}...`;
    };
    return {
      render(width: number): string[] {
        const header = `[delivery] ${label}`;
        const clippedHeader = clip(header, width);
        const prefix = "[delivery] ";
        const rest = clippedHeader.startsWith(prefix)
          ? clippedHeader.slice(prefix.length)
          : "";
        const line = rest
          ? `${theme.fg("accent", "[delivery]")} ${theme.fg(color, rest)}`
          : theme.fg("accent", clippedHeader);
        const lines = [line];
        if (reason) lines.push(theme.fg("text", clip(reason, width)));
        if (summary && opts.expanded !== false) {
          lines.push(theme.fg("muted", clip(summary, width)));
        }
        return lines;
      },
    };
  };
}

/** Never let a side-channel failure throw out of the handler. */
async function safe(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    /* ignore: appendEntry/notify failures must not block session end */
  }
}

interface StopState {
  /** Consecutive continues already issued (resets on any non-continue outcome). */
  continueRounds: number;
  /** Assistant-turn count at the last gate pass, keyed by session_id. */
  lastReviewCount: Map<string, number>;
  /** True while a TUI background review is running (duplicate-stop guard). */
  reviewInFlight: boolean;
  /** Detached TUI review tasks; drain() awaits them for deterministic tests. */
  pending: Promise<void>[];
}

/**
 * Build the session_stop handler. Exported for deterministic unit testing with
 * fake pi/ctx (no real model calls). `state` is exposed so tests can observe
 * the consecutive-continue counter; `drain` settles any detached TUI review
 * tasks so tests can assert their side effects deterministically.
 */
export function createStopHandler(pi: DeliveryPi, cfg: DeliveryConfig) {
  const state: StopState = {
    continueRounds: 0,
    lastReviewCount: new Map(),
    reviewInFlight: false,
    pending: [],
  };

  const handle = async (
    event: SessionStopEvent,
    ctx: DeliveryCtx,
  ): Promise<ContinueResponse | void> => {
    const sid = event.session_id ?? "";
    const tid = event.turn_id ?? "";
    const round = state.continueRounds + 1;
    const log = (level: "info" | "warn" | "error", msg: string): void => {
      try {
        pi.logger?.[level]?.(`[delivery] ${msg}`);
      } catch {
        /* ignore */
      }
    };
    const emitReview = async (fields: Record<string, unknown>): Promise<void> => {
      const merged: Record<string, unknown> = {
        round,
        session_id: sid,
        turn_id: tid,
        stop_hook_active: event.stop_hook_active === true,
        ...fields,
      };
      await safe(() => pi.appendEntry("delivery.review", merged));
      const status = String(merged.status ?? "unknown");
      if (["done", "continue", "need_user", "fail", "skip"].includes(status)) {
        await safe(() =>
          pi.sendMessage?.(buildReviewDisplayMessage(merged), { triggerTurn: false }),
        );
      }
    };

    // FR-014 — TUI constraint: respect the user's exit intent, no review by
    // default; enable_tui_review opts into the full headless pipeline.
    if (isTui(ctx) && !cfg.enable_tui_review) {
      await emitReview({ status: "skip", skipped: true, reason: "tui" });
      log("info", "TUI mode — skip review/continue (FR-014, enable_tui_review=false)");
      return;
    }
    if (isTui(ctx) && cfg.enable_tui_review) {
      log("info", "TUI mode — review enabled (enable_tui_review)");
    }

    // TUI async: at most one background review at a time. A second
    // session_stop while one is in flight would otherwise spawn a duplicate
    // review for the same session.
    if (isTui(ctx) && state.reviewInFlight) {
      log("info", "TUI mode — review already in flight; skip this stop");
      return;
    }

    // Assistant-turn increment gate: short repeated stops must not trigger
    // another review until >= min_assistant_turns_increment new assistant
    // turns exist since the last review (a first stop counts from 0). This is
    // a silent gate (no delivery.review entry/visible message) and runs before
    // the budget check so a passing gate records the count even when the
    // budget check later skips the review. A missing/empty session_id disables
    // the gate (original flow); compaction that shrinks assistant history
    // resets the baseline and stays silent.
    const assistantTurns = (event.messages ?? []).filter(
      (m) => m.role === "assistant",
    ).length;
    const sessKey = typeof sid === "string" && sid.length > 0 ? sid : null;
    if (cfg.min_assistant_turns_increment > 0 && sessKey !== null) {
      // last defaults to 0: a first stop counts from session start.
      const last = state.lastReviewCount.get(sessKey) ?? 0;
      if (assistantTurns < last) {
        // Compaction rewrote history: reset the baseline and stay silent
        // (the next stop decides against the new baseline).
        state.lastReviewCount.set(sessKey, assistantTurns);
        log(
          "info",
          `compaction reset: ${last} -> ${assistantTurns} new baseline (silent, will review on next +${cfg.min_assistant_turns_increment})`,
        );
        return;
      } else if (assistantTurns - last < cfg.min_assistant_turns_increment) {
        log(
          "info",
          `silent gate: ${assistantTurns - last}/${cfg.min_assistant_turns_increment} new assistant turns since last review`,
        );
        return;
      } else {
        // delta >= N: advance the baseline and fall through to the review.
        state.lastReviewCount.set(sessKey, assistantTurns);
      }
    }

    // FR-011 — budget protection (fail-open).
    let usage: ContextUsage;
    try {
      usage = await ctx.getContextUsage();
    } catch (err) {
      log("warn", `getContextUsage failed (${String(err)}); assuming within budget`);
      usage = { tokens: 0 };
    }
    if (overBudget(usage, cfg)) {
      const budgetDetail =
        typeof usage.percent === "number" && Number.isFinite(usage.percent)
          ? `${usage.percent}% > ${cfg.max_trigger_percent}%`
          : `${usage.tokens} > ${cfg.max_trigger_tokens}`;
      await emitReview({
        status: "skip",
        skipped: true,
        reason: "budget",
        detail: budgetDetail,
      });
      log(
        "info",
        `budget exceeded (${budgetDetail}) — skip review, allow end (FR-011)`,
      );
      return;
    }

    // FR-001/FR-002/FR-003 — package evidence.
    const pkg = packageMessages(event.messages ?? [], {
      window: cfg.context_window_messages,
      messageTruncateChars: cfg.message_truncate_chars,
      packageMaxChars: cfg.package_max_chars,
      compression: cfg.enable_compression,
    });

    // FR-003 — archive the raw package (best-effort).
    await safe(() =>
      pi.appendEntry("delivery.archive", {
        round,
        session_id: sid,
        turn_id: tid,
        encoding: cfg.enable_compression ? "gzip+base64" : "raw",
        payload: pkg.archive,
      }),
    );

    // Edge case: no user input in the window -> nothing to judge.
    if (!pkg.userInput) {
      await emitReview({ status: "skip", skipped: true, reason: "no_user_input" });
      log("info", "no user input in message window — skip review");
      return;
    }

    // FR-012 — resolve the review model; failure -> skip, no fallback.
    let modelId: string | null = null;
    try {
      modelId = toModelId(await ctx.models.resolve(cfg.review_model));
    } catch (err) {
      log("warn", `model resolve failed (${String(err)}) — skip review (FR-012)`);
    }
    if (!modelId) {
      await emitReview({
        status: "skip",
        skipped: true,
        reason: "model_resolve",
        detail: cfg.review_model,
      });
      return;
    }

    // FR-004/FR-005/FR-006/FR-013 — isolated review subprocess (fail-open).
    const prompt = buildReviewPrompt({
      userInput: pkg.userInput,
      plaintext: pkg.plaintext,
      maxReviewTokens: cfg.max_review_tokens,
    });
    const argv = [
      OMP_BIN,
      "-p",
      "--mode=json",
      "--model",
      modelId,
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--thinking=off",
      prompt,
    ];

    /**
     * Apply a review outcome with headless semantics. Returns the harness
     * continue response for headless; when `resume` is set (TUI async), the
     * continue path additionally pushes a `delivery.continue` custom message
     * with triggerTurn so the harness starts a new turn automatically.
     */
    const applyOutcome = async (
      outcome: ReviewOutcome,
      opts: { resume: boolean },
    ): Promise<ContinueResponse | void> => {
      if (!outcome.ok) {
        await emitReview({ status: "fail", skipped: true, reason: outcome.error });
        log("warn", `review failed (${outcome.error}) — allow end (FR-013)`);
        return;
      }

      // FR-007/FR-008/FR-009/FR-010 — decide.
      const decision = decide(outcome.result, state.continueRounds, cfg.max_continue_rounds);

      if (decision.action === "continue") {
        state.continueRounds += 1;
        const fields: Record<string, unknown> = {
          status: "continue",
          reason: outcome.result.reason,
        };
        if (outcome.result.summary != null) fields.summary = outcome.result.summary;
        await emitReview(fields);
        log(
          "info",
          `review: continue (round ${state.continueRounds}/${cfg.max_continue_rounds}) — resuming with feedback`,
        );
        if (opts.resume) {
          // TUI: the handler already returned; auto-resume a new turn via a
          // visible message that triggers it.
          await safe(() =>
            pi.sendMessage?.(
              {
                customType: "delivery.continue",
                content: decision.additionalContext,
                display: true,
                attribution: "agent",
                details: { ...fields, status: "continue" },
              },
              { triggerTurn: true, deliverAs: "nextTurn" },
            ),
          );
        }
        return { continue: true, additionalContext: decision.additionalContext };
      }

      // done | need_user — record, notify, allow the session to end.
      state.continueRounds = 0;
      const status =
        decision.action === "need_user" ? "need_user" : outcome.result.status;
      const finalFields: Record<string, unknown> = {
        status,
        reason: outcome.result.reason,
      };
      if (outcome.result.summary != null) finalFields.summary = outcome.result.summary;
      if (decision.action === "need_user" && outcome.result.status === "continue") {
        finalFields.detail = "soft cap reached";
      }
      await emitReview(finalFields);
      const notice =
        decision.action === "need_user"
          ? `[delivery] 评审需要你确认：${outcome.result.reason}`
          : `[delivery] 评审判定任务完成：${outcome.result.reason}`;
      await safe(() => ctx.ui?.notify?.(notice));
      log("info", `review: ${status} — ${outcome.result.reason}`);
      return;
    };

    // Headless: keep the synchronous path exactly as before — clamp the
    // timeout to fit safely inside omp's 30s session_stop handler cap (no
    // hung review child), forward the stop signal, and return the continue
    // response to the harness.
    if (!isTui(ctx)) {
      const reviewTimeoutMs = Math.max(
        1,
        Math.min(cfg.review_timeout_seconds * 1000, 25_000),
      );
      const outcome: ReviewOutcome = await runReview({
        argv,
        timeoutMs: reviewTimeoutMs,
        signal: event.signal,
        exec: pi.exec,
      });
      return await applyOutcome(outcome, { resume: false });
    }

    // TUI (enable_tui_review): run the review asynchronously in the
    // background — the handler returns immediately so session_stop never
    // blocks on the review. Timeout uses the configured review_timeout_seconds
    // WITHOUT the headless 25s clamp, and the session_stop signal is NOT
    // forwarded (it may abort right after the handler settles).
    state.reviewInFlight = true;
    const timeoutMs = Math.max(1, cfg.review_timeout_seconds * 1000);
    const run = (): void => {
      const p = (async () => {
        try {
          const outcome: ReviewOutcome = await runReview({
            argv,
            timeoutMs,
            exec: pi.exec,
          });
          await applyOutcome(outcome, { resume: true });
        } catch (err) {
          log("error", `TUI async review crashed (${String(err)})`);
          await safe(() =>
            emitReview({ status: "fail", skipped: true, reason: `crash: ${String(err)}` }),
          );
        } finally {
          state.reviewInFlight = false;
        }
      })();
      state.pending.push(p);
      const cleanup = (): void => {
        const i = state.pending.indexOf(p);
        if (i >= 0) state.pending.splice(i, 1);
      };
      // Detached promise: the inner try/catch keeps it from rejecting; the
      // catch on the finally chain is a belt-and-suspenders guard so a raw
      // rejection can never crash the session (omp aborts on unhandled
      // rejections from extension handlers).
      void p.finally(cleanup).catch(() => {});
    };
    if (ctx.setTimeout) ctx.setTimeout(() => run(), 0);
    else run();
    return;
  };

  const drain = async (): Promise<void> => {
    while (state.pending.length) {
      await state.pending[0];
    }
  };

  return { handle, state, drain };
}

/** Extension entry point: register the session_stop hook. */
export default function delivery(pi: ExtensionAPI): void {
  const cfg = loadFileConfig();
  const { handle } = createStopHandler(pi, cfg);
  pi.on("session_stop", handle);
  pi.registerMessageRenderer?.("delivery.review", createReviewMessageRenderer());
}
