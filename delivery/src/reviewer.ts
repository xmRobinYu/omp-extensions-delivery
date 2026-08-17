/**
 * delivery — isolated read-only review (FR-004/FR-005/FR-006/FR-013).
 *
 * Spawns an `omp -p` subprocess with the review prompt as the last positional
 * argument (probe-verified argv form — see REVIEW_ARGV_PROBE.md; @file and
 * --cwd are intentionally NOT used), parses the NDJSON event stream, extracts
 * the last `message_end` assistant text, and validates the JSON verdict.
 *
 * Everything fails open: spawn/timeout/exit/parse failures surface as
 * `{ ok: false }` and the caller lets the session end normally.
 */
import type { ExecOpts, ExecResult, ReviewResult } from "./types.ts";

/** omp binary path; overridable via OMP_BIN (e.g. in tests/probes). */
export const OMP_BIN = process.env.OMP_BIN ?? "omp";

export interface ReviewPromptInput {
  /** Most recent non-empty user text (the current dev task). */
  userInput: string;
  /** Truncated structured plaintext evidence (tool_result text readable). */
  plaintext: string;
  /** Informational cap for the review response length. */
  maxReviewTokens?: number;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const tokenCap =
    input.maxReviewTokens != null
      ? `\n- 请将整个回复控制在 ${input.maxReviewTokens} tokens 以内。`
      : "";
  return `你是 AI 编码代理会话的独立只读评审员。

你的唯一任务：仅依据下方证据，判断代理的开发任务是否真正完成。

评审规则：
- 代理的最终总结（summary）不可信。切勿依赖它，只能依据证据判断。
- 判断原始用户请求（user_input）是否真正得到满足。
- 测试与验证必须通过：请检查证据块中的 tool_result 证据（测试/验证输出）。
- 代理正文或代码块中引用的 read/write/命令不是 tool_result，不计入证据。
- 若代理声称完成但缺少 tool_result 证据，且缺失疑似源于会话能力限制（如没有写文件工具），判 continue 时 reason 必须要求代理：明确声明能力限制，并改用会话可用的方式（如只读分析）交付；不得要求代理执行其无法执行的写入操作。
- 若代理本轮回复与上一轮明显重复（相同伪命令、相同文本、相同结论），应判定 need_user，reason 说明“代理重复空转，需要人类决策”，而不是继续。
- 你没有工具，不得执行、修改或提出任何代码。只能以 JSON 作答。
- reason 与 summary 必须使用简体中文撰写，禁止使用英文自然语言。${tokenCap}

<user_input>
${input.userInput}
</user_input>

<evidence>
${input.plaintext}
</evidence>

只输出一个 JSON 对象，不要输出任何其他内容：
{"status": "done" | "continue" | "need_user", "reason": "<简要的基于证据的原因>", "summary": "<一句话摘要>"}

只输出 JSON 对象。不要散文、不要 markdown 代码围栏、不要任何评论。

示例：
{"status":"continue","reason":"测试尚未全部通过，需要补充回归测试","summary":"继续修复直到测试通过"}

- "done"：用户请求真正完成，且测试/验证已通过。
- "continue"：代理可以并且应该继续自主工作；你的 "reason" 必须具体说明要修复什么以及如何验证。
- "need_user"：任务被阻塞或含糊不清，需要人类决策或输入。
`;
}

/**
 * Parse an NDJSON event stream and return the text of the LAST `message_end`
 * event (final assistant answer). Non-JSON lines are skipped.
 */
export function extractLastAssistantText(ndjson: string): string | null {
  if (!ndjson || !ndjson.trim()) return null;
  let last: string | null = null;
  for (const rawLine of ndjson.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    const obj = ev as Record<string, unknown>;
    if (obj.type !== "message_end") continue;
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message.content)) continue;
    const text = (message.content as Record<string, unknown>[])
      .filter(
        (b) =>
          b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text as string)
      .join("\n\n");
    if (text.trim()) last = text;
  }
  return last;
}

/**
 * Validate a review verdict from assistant text, tolerating ```json fences and
 * surrounding prose. Returns null when no valid verdict is present.
 */
export function parseReviewJson(text: string): ReviewResult | null {
  if (!text || !text.trim()) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (status !== "done" && status !== "continue" && status !== "need_user") return null;
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  const summary = typeof obj.summary === "string" ? obj.summary : undefined;
  return { status, reason, summary };
}

export interface RunReviewDeps {
  /** argv[0] = binary; rest = args; prompt is the last positional arg. */
  argv: string[];
  /** Timeout in ms; fail-open on expiry. */
  timeoutMs: number;
  /** AbortSignal forwarded to exec; aborting fails open as timeout. */
  signal?: AbortSignal;
  /** exec-like function (pi.exec in production, fake in tests). */
  exec: (cmd: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;
  /** Max attempts for parse failures only; default 2. */
  attempts?: number;
}

export type ReviewOutcome =
  | { ok: true; result: ReviewResult }
  | { ok: false; error: string };

const TIMEOUT = Symbol("review-timeout");

const RETRY_NUDGE =
  "\n\n你上次的回复不是有效的 JSON。请只输出 JSON 对象，不要输出任何其他内容。";

type AttemptOutcome =
  | { kind: "ok"; result: ReviewResult }
  | { kind: "timeout" }
  | { kind: "spawn"; message: string }
  | { kind: "exit"; code: number | null; stderr: string }
  | { kind: "no-text" }
  | { kind: "parse" };

/**
 * True when an exec rejection represents a timeout or abort (the harness
 * kills the child at the deadline and rejects, or aborts via the signal).
 * Detected by error name/message; everything else stays a spawn error.
 */
function isTimeoutLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name.toLowerCase();
  const message = err.message.toLowerCase();
  return (
    name.includes("abort") ||
    name.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

/**
 * Run one review subprocess attempt; never throws.
 *
 * The exec function MUST be invoked as `deps.exec(...)` (member call), not via
 * a bare local reference: the installed omp harness's exec reads `this.cwd`,
 * and a bare call would set `this` to undefined and throw.
 */
async function attemptOnce(
  deps: RunReviewDeps,
  argv: string[],
): Promise<AttemptOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(TIMEOUT), Math.max(1, deps.timeoutMs));
  });

  let res: ExecResult;
  try {
    const execPromise = deps.exec(argv[0], argv.slice(1), {
      signal: deps.signal,
      timeout: deps.timeoutMs,
    });
    res = await Promise.race([execPromise, timeout]);
  } catch (err) {
    if (err === TIMEOUT) return { kind: "timeout" };
    if (isTimeoutLike(err)) return { kind: "timeout" };
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "spawn", message: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // The harness killed the child at the deadline -> treat exactly like a timeout.
  if (res.killed === true) return { kind: "timeout" };

  if (res.code !== 0) {
    return {
      kind: "exit",
      code: res.code,
      stderr: (res.stderr || "").slice(0, 400),
    };
  }
  const text = extractLastAssistantText(res.stdout);
  if (text == null) return { kind: "no-text" };
  const result = parseReviewJson(text);
  if (!result) return { kind: "parse" };
  return { kind: "ok", result };
}

/** Run the isolated review subprocess; never throws, always fail-open. */
export async function runReview(deps: RunReviewDeps): Promise<ReviewOutcome> {
  const attempts = Math.max(1, deps.attempts ?? 2);
  let argv = deps.argv.slice();
  for (let i = 0; i < attempts; i++) {
    const outcome = await attemptOnce(deps, argv);
    switch (outcome.kind) {
      case "ok":
        return { ok: true, result: outcome.result };
      case "timeout":
        return { ok: false, error: "timeout" };
      case "spawn":
        return { ok: false, error: `spawn: ${outcome.message}` };
      case "exit":
        return {
          ok: false,
          error: `exit ${String(outcome.code)}: ${outcome.stderr || "(no stderr)"}`,
        };
      case "no-text":
        return { ok: false, error: "no assistant text in output" };
      case "parse":
        if (i < attempts - 1) {
          const last = argv[argv.length - 1] ?? "";
          argv = [...argv.slice(0, -1), `${last}${RETRY_NUDGE}`];
          continue;
        }
        return { ok: false, error: "invalid review JSON" };
    }
  }
  return { ok: false, error: "invalid review JSON" };
}
