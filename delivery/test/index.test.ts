import { describe, expect, test } from "bun:test";
import delivery, {
  buildReviewDisplayMessage,
  createReviewMessageRenderer,
  createStopHandler,
  isTui,
  loadFileConfig,
  overBudget,
  toModelId,
} from "../index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  CustomMessagePayload,
  DeliveryCtx,
  DeliveryPi,
  ExecOpts,
  ExecResult,
  SessionStopEvent,
  SessionMessage,
} from "../src/types.ts";

const user = (text: string): SessionMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});
const tool = (text: string, isError = false): SessionMessage => ({
  role: "toolResult",
  content: [{ type: "text", text }],
  toolName: "test",
  isError,
});
const assistant = (text: string): SessionMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const event = (
  messages: SessionMessage[] = [
    user("fix the bug"),
    tool("1 failed"),
    ...Array.from({ length: 10 }, (_, i) => assistant(`assistant turn ${i + 1}`)),
  ],
): SessionStopEvent => ({
  messages,
  session_id: "s1",
  turn_id: "t1",
  stop_hook_active: true,
});
const eventWithTurns = (assistantCount: number): SessionStopEvent =>
  event([
    user("fix the bug"),
    tool("1 failed"),
    ...Array.from({ length: assistantCount }, (_, i) => assistant(`assistant turn ${i + 1}`)),
  ]);

const doneNdjson = (reason = "测试全部通过"): string =>
  JSON.stringify({
    type: "message_end",
    message: {
      content: [{ type: "text", text: JSON.stringify({ status: "done", reason }) }],
    },
  });

interface Harness {
  pi: DeliveryPi;
  handle: ReturnType<typeof createStopHandler>["handle"];
  state: ReturnType<typeof createStopHandler>["state"];
  drain: ReturnType<typeof createStopHandler>["drain"];
  entries: Array<{ type: string; data: Record<string, unknown> }>;
  execCalls: Array<{ cmd: string; args: string[]; opts?: ExecOpts }>;
  notified: string[];
  sent: Array<{
    message: CustomMessagePayload;
    opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
  }>;
  ctx: DeliveryCtx;
}

function makeHarness(overrides: Partial<DeliveryPi> = {}): Harness {
  const entries: Harness["entries"] = [];
  const execCalls: Harness["execCalls"] = [];
  const notified: string[] = [];
  const sent: Harness["sent"] = [];
  const pi: DeliveryPi = {
    exec: async (cmd, args, opts) => {
      execCalls.push({ cmd, args, opts });
      return { code: 0, stdout: doneNdjson(), stderr: "" } satisfies ExecResult;
    },
    appendEntry: async (type, data) => {
      entries.push({ type, data: data as Record<string, unknown> });
    },
    sendMessage: async (message, opts) => {
      sent.push({ message, opts });
    },
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
  const { handle, state, drain } = createStopHandler(pi, DEFAULT_CONFIG);
  const ctx: DeliveryCtx = {
    hasUI: false,
    getContextUsage: async () => ({ tokens: 1 }),
    models: {
      resolve: async () => "deepseek-proxy/deepseek-v4-flash",
      current: async () => null,
      list: async () => [],
    },
    ui: {
      notify: async (m) => {
        notified.push(m);
      },
    },
  };
  return { pi, handle, state, drain, entries, execCalls, notified, sent, ctx };
}

describe("delivery factory", () => {
  test("registers a session_stop handler and review renderer", () => {
    let registered = 0;
    let rendererRegistered = 0;
    const api = {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      appendEntry: () => {},
      on: (evt: string) => {
        expect(evt).toBe("session_stop");
        registered += 1;
      },
      registerMessageRenderer: (type: string, fn: unknown) => {
        expect(type).toBe("delivery.review");
        expect(typeof fn).toBe("function");
        rendererRegistered += 1;
      },
    };
    delivery(api as never);
    expect(registered).toBe(1);
    expect(rendererRegistered).toBe(1);
  });

  test("loadFileConfig reads the real config file", () => {
    expect(loadFileConfig()).toEqual({
      ...DEFAULT_CONFIG,
      review_model: "otokapi/gpt-5.6-terra:high",
      enable_tui_review: true,
    });
  });
});

describe("helpers", () => {
  test("isTui/toModelId", () => {
    expect(isTui({ hasUI: true } as DeliveryCtx)).toBe(true);
    expect(isTui({ hasUI: false } as DeliveryCtx)).toBe(false);
    expect(toModelId("m/v")).toBe("m/v");
    expect(toModelId({ id: "x/y" })).toBe("x/y");
    expect(toModelId({ provider: "claude-proxy", id: "claude-sonnet-5" })).toBe(
      "claude-proxy/claude-sonnet-5",
    );
    expect(toModelId({ provider: "claude-proxy", id: "claude-proxy/claude-sonnet-5" })).toBe(
      "claude-proxy/claude-sonnet-5",
    );
    expect(toModelId({ name: "n" })).toBe("n");
    expect(toModelId(7)).toBeNull();
    expect(toModelId({})).toBeNull();
  });

  test("overBudget prefers percent and falls back to tokens", () => {
    const cfg = {
      max_trigger_percent: 90,
      max_trigger_tokens: 500_000,
    };
    expect(overBudget({ tokens: 0, percent: 91 }, cfg)).toBe(true);
    expect(overBudget({ tokens: 0, percent: 90 }, cfg)).toBe(false);
    expect(overBudget({ tokens: 0, percent: 89 }, cfg)).toBe(false);
    expect(overBudget({ tokens: 0 }, cfg)).toBe(false);
    expect(overBudget({ tokens: 500_000 }, cfg)).toBe(false);
    expect(overBudget({ tokens: 500_001 }, cfg)).toBe(true);
    expect(overBudget({ tokens: 0, percent: NaN }, cfg)).toBe(false);
    expect(overBudget({ tokens: 500_001, percent: NaN }, cfg)).toBe(true);
    expect(overBudget({ tokens: 0, percent: Infinity }, cfg)).toBe(false);
    expect(overBudget({ tokens: 500_001, percent: Infinity }, cfg)).toBe(true);
  });
});

describe("delivery.review custom_message", () => {
  test("buildReviewDisplayMessage creates display payload with details", () => {
    const m = buildReviewDisplayMessage({
      status: "done",
      reason: "测试全部通过",
      summary: "全部通过",
    });
    expect(m).toEqual({
      customType: "delivery.review",
      content: "[delivery] 评审完成：测试全部通过\n全部通过",
      display: true,
      attribution: "agent",
      details: expect.objectContaining({
        status: "done",
        reason: "测试全部通过",
        summary: "全部通过",
      }),
    });
    expect(buildReviewDisplayMessage({ status: "need_user" }).content).toBe(
      "[delivery] 需要你确认",
    );
  });

  test("skip status maps machine-readable reason to Chinese in content, keeps raw in details", () => {
    const m = buildReviewDisplayMessage({ status: "skip", reason: "no_user_input" });
    expect(m.content).toBe("[delivery] 评审跳过：会话中没有用户输入，无法评审");
    expect(m.details).toMatchObject({ status: "skip", reason: "no_user_input" });

    expect(buildReviewDisplayMessage({ status: "skip", reason: "tui" }).content).toBe(
      "[delivery] 评审跳过：TUI 模式未启用评审",
    );
    expect(buildReviewDisplayMessage({ status: "skip", reason: "budget" }).content).toBe(
      "[delivery] 评审跳过：上下文预算超限，跳过评审",
    );
    expect(buildReviewDisplayMessage({ status: "skip", reason: "model_resolve" }).content).toBe(
      "[delivery] 评审跳过：评审模型解析失败",
    );
    // Unknown skip reason passes through unchanged (fallback).
    expect(buildReviewDisplayMessage({ status: "skip", reason: "weird_reason" }).content).toBe(
      "[delivery] 评审跳过：weird_reason",
    );
  });

  test("renderer colors status, reason, and summary lines", () => {
    const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
    const renderer = createReviewMessageRenderer();
    const done = renderer(
      { details: { status: "done", reason: "测试全部通过", summary: "全部通过" } },
      { expanded: true },
      theme,
    ).render(80);
    expect(done).toEqual([
      "<accent>[delivery]</accent> <success>评审完成</success>",
      "<text>测试全部通过</text>",
      "<muted>全部通过</muted>",
    ]);
    const statuses: Array<[string, string, string]> = [
      ["continue", "accent", "评审：继续"],
      ["need_user", "warning", "需要你确认"],
      ["fail", "error", "评审失败"],
    ];
    for (const [status, color, label] of statuses) {
      const lines = renderer({ details: { status } }, {}, theme).render(80);
      expect(lines[0]).toBe(`<accent>[delivery]</accent> <${color}>${label}</${color}>`);
    }
  });

  test("renderer maps skip reason to Chinese and keeps the muted color", () => {
    const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
    const renderer = createReviewMessageRenderer();
    const lines = renderer(
      { details: { status: "skip", reason: "no_user_input" } },
      {},
      theme,
    ).render(80);
    expect(lines).toEqual([
      "<accent>[delivery]</accent> <muted>评审跳过</muted>",
      "<text>会话中没有用户输入，无法评审</text>",
    ]);
    // Unknown reason passes through unchanged.
    const fallback = renderer({ details: { status: "skip", reason: "xyz" } }, {}, theme).render(80);
    expect(fallback[1]).toBe("<text>xyz</text>");
  });

  test("renderer collapses summary and clips long text to width", () => {
    const theme = { fg: (_c: string, t: string) => t };
    const renderer = createReviewMessageRenderer();
    const collapsed = renderer(
      { details: { status: "continue", reason: "请补充测试", summary: "隐藏" } },
      { expanded: false },
      theme,
    ).render(80);
    expect(collapsed).toEqual(["[delivery] 评审：继续", "请补充测试"]);
    const clipped = renderer(
      { details: { status: "fail", reason: "x".repeat(60), summary: "y".repeat(60) } },
      {},
      theme,
    ).render(20);
    expect(clipped).toHaveLength(3);
    for (const line of clipped) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  test("done review is pushed as custom_message without triggerTurn", async () => {
    const h = makeHarness();
    await h.handle(event(), h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message).toMatchObject({
      customType: "delivery.review",
      content: "[delivery] 评审完成：测试全部通过",
      display: true,
      attribution: "agent",
    });
    expect(h.sent[0].opts).toEqual({ triggerTurn: false });
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "done" });
  });

  test("continue review is pushed as custom_message", async () => {
    const h = makeHarness({
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "continue",
                  reason: "请补充回归测试",
                }),
              },
            ],
          },
        }),
        stderr: "",
      }),
    });
    const result = await h.handle(event(), h.ctx);
    expect(result).toEqual({ continue: true, additionalContext: expect.any(String) });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message.content).toBe(
      "[delivery] 评审：继续：请补充回归测试",
    );
    expect(h.sent[0].opts).toEqual({ triggerTurn: false });
  });

  test("need_user review is pushed as custom_message", async () => {
    const h = makeHarness({
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "need_user", reason: "请确认 API 选型" }),
              },
            ],
          },
        }),
        stderr: "",
      }),
    });
    const result = await h.handle(event(), h.ctx);
    expect(result).toBeUndefined();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message.content).toBe("[delivery] 需要你确认：请确认 API 选型");
  });

  test("fail review is pushed as custom_message", async () => {
    const h = makeHarness({
      exec: async () => {
        throw new Error("ENOENT");
      },
    });
    await h.handle(event(), h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message).toMatchObject({
      customType: "delivery.review",
      display: true,
      attribution: "agent",
    });
    expect(h.sent[0].message.content.startsWith("[delivery] 评审失败")).toBe(true);
  });

  test("TUI skip pushes visible message with Chinese reason", async () => {
    const h = makeHarness();
    await h.handle(event(), { ...h.ctx, hasUI: true });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message).toMatchObject({
      customType: "delivery.review",
      display: true,
      attribution: "agent",
      content: "[delivery] 评审跳过：TUI 模式未启用评审",
    });
    expect(h.sent[0].message.details).toMatchObject({ status: "skip", reason: "tui" });
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "skip", reason: "tui" });
  });

  test("budget skip pushes visible message with Chinese reason", async () => {
    const h = makeHarness();
    const ctx = {
      ...h.ctx,
      getContextUsage: async () => ({ tokens: DEFAULT_CONFIG.max_trigger_tokens + 1 }),
    };
    await h.handle(event(), ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message).toMatchObject({
      customType: "delivery.review",
      content: "[delivery] 评审跳过：上下文预算超限，跳过评审",
    });
    expect(h.sent[0].message.details).toMatchObject({ status: "skip", reason: "budget" });
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "skip", reason: "budget" });
  });

  test("no_user_input skip pushes visible message with Chinese reason", async () => {
    const h = makeHarness();
    await h.handle(event([tool("result only"), ...Array.from({ length: 10 }, (_, i) => assistant(`assistant turn ${i + 1}`))]), h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message).toMatchObject({
      customType: "delivery.review",
      content: "[delivery] 评审跳过：会话中没有用户输入，无法评审",
    });
    expect(h.sent[0].message.details).toMatchObject({ status: "skip", reason: "no_user_input" });
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "skip", reason: "no_user_input" });
  });

  test("model_resolve skip pushes visible message with Chinese reason", async () => {
    const h = makeHarness();
    const ctx = {
      ...h.ctx,
      models: {
        resolve: async () => null,
        current: async () => null,
        list: async () => [],
      },
    };
    await h.handle(event(), ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].message).toMatchObject({
      customType: "delivery.review",
      content: "[delivery] 评审跳过：评审模型解析失败",
    });
    expect(h.sent[0].message.details).toMatchObject({ status: "skip", reason: "model_resolve" });
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "skip", reason: "model_resolve" });
  });
});

describe("session_stop handler", () => {
  test("TUI mode with default config skips review and allows end (FR-014)", async () => {
    const h = makeHarness();
    const result = await h.handle(event(), { ...h.ctx, hasUI: true });
    expect(result).toBeUndefined();
    expect(h.execCalls).toHaveLength(0);
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "skip", reason: "tui" });
  });

  test("TUI review opt-in runs archive + review pipeline asynchronously (FR-014 override)", async () => {
    const h = makeHarness();
    const cfg = { ...DEFAULT_CONFIG, enable_tui_review: true };
    const { handle, drain } = createStopHandler(h.pi, cfg);
    const result = await handle(event(), { ...h.ctx, hasUI: true });
    expect(result).toBeUndefined();
    await drain();
    expect(h.execCalls).toHaveLength(1);
    expect(h.entries.find((e) => e.type === "delivery.archive")).toBeDefined();
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "done" });
  });

  test("TUI review opt-in continue pushes delivery.continue + triggerTurn (async)", async () => {
    const h = makeHarness({
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "continue", reason: "add a regression test" }),
              },
            ],
          },
        }),
        stderr: "",
      }),
    });
    const cfg = { ...DEFAULT_CONFIG, enable_tui_review: true };
    const { handle, drain, state } = createStopHandler(h.pi, cfg);
    const result = await handle(event(), { ...h.ctx, hasUI: true });
    expect(result).toBeUndefined();
    await drain();
    expect(state.continueRounds).toBe(1);
    expect(h.entries.find((e) => e.type === "delivery.archive")).toBeDefined();
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "continue" });
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0].message).toMatchObject({ customType: "delivery.review" });
    expect(h.sent[0].opts).toEqual({ triggerTurn: false });
    expect(h.sent[1].message).toMatchObject({
      customType: "delivery.continue",
      display: true,
      attribution: "agent",
    });
    expect(h.sent[1].message.details).toMatchObject({ status: "continue" });
    expect(h.sent[1].opts).toEqual({ triggerTurn: true, deliverAs: "nextTurn" });
    expect(String(h.sent[1].message.content)).toContain("第 1 轮");
  });

  test("TUI async review timeout is not clamped to 25s", async () => {
    const h = makeHarness();
    const cfg = {
      ...DEFAULT_CONFIG,
      enable_tui_review: true,
      review_timeout_seconds: 60,
    };
    const { handle, drain } = createStopHandler(h.pi, cfg);
    const result = await handle(event(), { ...h.ctx, hasUI: true });
    expect(result).toBeUndefined();
    await drain();
    expect(h.execCalls).toHaveLength(1);
    expect(h.execCalls[0].opts?.timeout).toBe(60_000);
  });

  test("TUI async review does not forward the session_stop signal", async () => {
    const h = makeHarness();
    const cfg = { ...DEFAULT_CONFIG, enable_tui_review: true };
    const { handle, drain } = createStopHandler(h.pi, cfg);
    const ac = new AbortController();
    const evt = event();
    evt.signal = ac.signal;
    const result = await handle(evt, { ...h.ctx, hasUI: true });
    expect(result).toBeUndefined();
    await drain();
    expect(h.execCalls).toHaveLength(1);
    expect(h.execCalls[0].opts?.signal).toBeUndefined();
  });

  test("TUI in-flight guard: a second stop during review does not duplicate it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let execCount = 0;
    const h = makeHarness({
      exec: async () => {
        execCount += 1;
        await gate;
        return { code: 0, stdout: doneNdjson(), stderr: "" };
      },
    });
    const cfg = { ...DEFAULT_CONFIG, enable_tui_review: true, min_assistant_turns_increment: 0 };
    const { handle, drain } = createStopHandler(h.pi, cfg);
    const first = await handle(event(), { ...h.ctx, hasUI: true });
    expect(first).toBeUndefined();
    // The first review is now in flight (background task pending on the gate).
    const second = await handle(event(), { ...h.ctx, hasUI: true });
    expect(second).toBeUndefined();
    expect(execCount).toBe(1); // in-flight guard blocked the duplicate
    release();
    await drain();
  });

  test("TUI async review failure emits fail in the background", async () => {
    const h = makeHarness({
      exec: async () => {
        throw new Error("ENOENT");
      },
    });
    const cfg = { ...DEFAULT_CONFIG, enable_tui_review: true };
    const { handle, drain } = createStopHandler(h.pi, cfg);
    const result = await handle(event(), { ...h.ctx, hasUI: true });
    expect(result).toBeUndefined();
    await drain();
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "fail" });
  });

  test("TUI async done notifies after drain", async () => {
    const h = makeHarness();
    const cfg = { ...DEFAULT_CONFIG, enable_tui_review: true };
    const { handle, drain } = createStopHandler(h.pi, cfg);
    const result = await handle(event(), { ...h.ctx, hasUI: true });
    expect(result).toBeUndefined();
    await drain();
    expect(h.notified).toEqual(["[delivery] 评审判定任务完成：测试全部通过"]);
  });

  test("over-budget skips review and allows end (FR-011)", async () => {
    const h = makeHarness();
    const ctx = {
      ...h.ctx,
      getContextUsage: async () => ({ tokens: DEFAULT_CONFIG.max_trigger_tokens + 1 }),
    };
    const result = await h.handle(event(), ctx);
    expect(result).toBeUndefined();
    expect(h.execCalls).toHaveLength(0);
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "skip", reason: "budget" });
  });

  test("budget failure fails open", async () => {
    const h = makeHarness();
    const ctx = {
      ...h.ctx,
      getContextUsage: async () => {
        throw new Error("nope");
      },
    };
    await expect(h.handle(event(), ctx)).resolves.toBeUndefined();
    expect(h.execCalls).toHaveLength(1); // treated as within budget
  });

  test("archives raw window via delivery.archive (FR-003)", async () => {
    const h = makeHarness();
    await h.handle(event(), h.ctx);
    const archive = h.entries.find((e) => e.type === "delivery.archive");
    expect(archive).toBeDefined();
    expect(archive!.data).toMatchObject({ encoding: "gzip+base64" });
    expect(typeof archive!.data.payload).toBe("string");
  });

  test("no user input skips review", async () => {
    const h = makeHarness();
    const result = await h.handle(event([tool("result only"), ...Array.from({ length: 10 }, (_, i) => assistant(`assistant turn ${i + 1}`))]), h.ctx);
    expect(result).toBeUndefined();
    expect(h.execCalls).toHaveLength(0);
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "skip", reason: "no_user_input" });
  });

  test("model resolve failure skips review, no fallback (FR-012)", async () => {
    const h = makeHarness();
    const ctx = {
      ...h.ctx,
      models: {
        resolve: async () => null,
        current: async () => null,
        list: async () => [],
      },
    };
    const result = await h.handle(event(), ctx);
    expect(result).toBeUndefined();
    expect(h.execCalls).toHaveLength(0);
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "skip", reason: "model_resolve" });
  });

  test("spawns isolated argv with verified flags and prompt last", async () => {
    const h = makeHarness();
    await h.handle(event(), h.ctx);
    expect(h.execCalls).toHaveLength(1);
    const { cmd, args } = h.execCalls[0];
    expect(cmd).toBe("omp");
    expect(args).toEqual([
      "-p",
      "--mode=json",
      "--model",
      DEFAULT_CONFIG.review_model,
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--thinking=off",
      expect.stringContaining("fix the bug") as string,
    ]);
  });

  test("review argv includes --thinking=off before the prompt", async () => {
    const h = makeHarness();
    await h.handle(event(), h.ctx);
    const { args } = h.execCalls[0];
    const idx = args.indexOf("--thinking=off");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toEqual(expect.stringContaining("fix the bug") as string);
    expect(args.slice(0, idx)).toContain("--no-rules");
  });

  test("resolved provider+id object becomes fully qualified --model", async () => {
    const h = makeHarness();
    const ctx = {
      ...h.ctx,
      models: {
        resolve: async () => ({ provider: "claude-proxy", id: "claude-sonnet-5" }),
        current: async () => null,
        list: async () => [],
      },
    };
    await h.handle(event(), ctx);
    expect(h.execCalls).toHaveLength(1);
    const { args } = h.execCalls[0];
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("claude-proxy/claude-sonnet-5");
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "done" });
  });

  test("review timeout is clamped to 25000ms even when config says 60s", async () => {
    expect(DEFAULT_CONFIG.review_timeout_seconds).toBe(60); // 60_000ms > cap
    const h = makeHarness();
    await h.handle(event(), h.ctx);
    expect(h.execCalls[0].opts?.timeout).toBe(25_000);

    // Floor: a 0s config still yields a positive timeout.
    const h2 = makeHarness();
    const cfg = { ...DEFAULT_CONFIG, review_timeout_seconds: 0 };
    const { handle } = createStopHandler(h2.pi, cfg);
    await handle(event(), h2.ctx);
    expect(h2.execCalls[0].opts?.timeout).toBe(1);
  });

  test("session_stop signal is forwarded to the review exec opts", async () => {
    const h = makeHarness();
    const ac = new AbortController();
    const evt = event();
    evt.signal = ac.signal;
    await h.handle(evt, h.ctx);
    expect(h.execCalls[0].opts?.signal).toBe(ac.signal);
  });

  test("review timeout/spawn failure fails open and allows end (FR-013)", async () => {
    const h = makeHarness({
      exec: async () => {
        throw new Error("ENOENT");
      },
    });
    const result = await h.handle(event(), h.ctx);
    expect(result).toBeUndefined();
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "fail" });
  });

  test("invalid review output fails open", async () => {
    const h = makeHarness({
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "message_end",
          message: { content: [{ type: "text", text: "no json" }] },
        }),
        stderr: "",
      }),
    });
    const result = await h.handle(event(), h.ctx);
    expect(result).toBeUndefined();
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "fail" });
  });

  test("done notifies and allows end", async () => {
    const h = makeHarness();
    const result = await h.handle(event(), h.ctx);
    expect(result).toBeUndefined();
    expect(h.notified).toEqual(["[delivery] 评审判定任务完成：测试全部通过"]);
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "done" });
  });

  test("continue returns harness response with feedback and counts rounds", async () => {
    const h = makeHarness({
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "continue",
                  reason: "请补充回归测试",
                }),
              },
            ],
          },
        }),
        stderr: "",
      }),
    });
    const first = await h.handle(eventWithTurns(10), h.ctx);
    expect(first).toEqual({
      continue: true,
      additionalContext: expect.stringContaining("第 1 轮") as string,
    });
    expect(h.state.continueRounds).toBe(1);
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "continue" });

    const second = await h.handle(eventWithTurns(20), h.ctx);
    expect(second).toEqual({
      continue: true,
      additionalContext: expect.stringContaining("第 2 轮") as string,
    });
    expect(h.state.continueRounds).toBe(2);
  });

  test("continue beyond soft cap escalates to need_user (FR-010)", async () => {
    const h = makeHarness({
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "continue", reason: "仍在继续修复" }),
              },
            ],
          },
        }),
        stderr: "",
      }),
    });
    const cfg = { ...DEFAULT_CONFIG, max_continue_rounds: 1 };
    const { handle, state } = createStopHandler(h.pi, cfg);
    const ctx = h.ctx;

    const first = await handle(eventWithTurns(10), ctx);
    expect(first).toEqual({ continue: true, additionalContext: expect.any(String) as string });
    expect(state.continueRounds).toBe(1);

    const second = await handle(eventWithTurns(20), ctx);
    expect(second).toBeUndefined();
    expect(state.continueRounds).toBe(0); // reset on non-continue
    expect(h.notified).toContain("[delivery] 评审需要你确认：仍在继续修复");
    expect(h.entries.at(-1)?.data).toMatchObject({
      status: "need_user",
      detail: "soft cap reached",
    });
  });

  test("silent gate suppresses repeated stops before min_assistant_turns_increment", async () => {
    const cfg = { ...DEFAULT_CONFIG, min_assistant_turns_increment: 10 };
    const h = makeHarness();
    const { handle, state } = createStopHandler(h.pi, cfg);
    const ctx = h.ctx;

    await handle(eventWithTurns(10), ctx);
    expect(state.lastReviewCount.get("s1")).toBe(10);
    expect(h.execCalls).toHaveLength(1);
    const entriesAfterFirst = h.entries.length;
    const notifiedAfterFirst = h.notified.length;
    const sentAfterFirst = h.sent.length;

    await handle(eventWithTurns(10), ctx);
    expect(h.execCalls).toHaveLength(1);
    expect(h.entries).toHaveLength(entriesAfterFirst);
    expect(h.notified).toHaveLength(notifiedAfterFirst);
    expect(h.sent).toHaveLength(sentAfterFirst);
  });

  test("silent gate records a pass before a later budget skip (FR-011 order)", async () => {
    const cfg = { ...DEFAULT_CONFIG, min_assistant_turns_increment: 10 };
    const h = makeHarness();
    const { handle, state } = createStopHandler(h.pi, cfg);
    const ctx = {
      ...h.ctx,
      getContextUsage: async () => ({ tokens: 500000, percent: 99 }),
    };

    await handle(eventWithTurns(10), ctx);
    expect(state.lastReviewCount.get("s1")).toBe(10);
    expect(h.execCalls).toHaveLength(0);
    expect(h.entries).toHaveLength(1);

    await handle(eventWithTurns(20), ctx);
    expect(state.lastReviewCount.get("s1")).toBe(20);
    expect(h.execCalls).toHaveLength(0);
    expect(h.entries).toHaveLength(2);

    await handle(eventWithTurns(20), ctx);
    expect(h.execCalls).toHaveLength(0);
    expect(h.entries).toHaveLength(2);
  });

  test("silent gate state is keyed per session_id", async () => {
    const cfg = { ...DEFAULT_CONFIG, min_assistant_turns_increment: 10 };
    const h = makeHarness();
    const { handle, state } = createStopHandler(h.pi, cfg);
    const ctx = h.ctx;

    await handle(eventWithTurns(10), ctx);
    await handle({ ...eventWithTurns(10), session_id: "s2" }, ctx);
    expect(state.lastReviewCount.get("s1")).toBe(10);
    expect(state.lastReviewCount.get("s2")).toBe(10);
    expect(h.execCalls).toHaveLength(2);
    const execAfterFreshSession = h.execCalls.length;

    await handle(eventWithTurns(10), ctx);
    expect(h.execCalls).toHaveLength(execAfterFreshSession);
    expect(h.entries.at(-1)?.data).toMatchObject({ status: "done" });
  });

  test("min_assistant_turns_increment 0 disables the silent gate", async () => {
    const cfg = { ...DEFAULT_CONFIG, min_assistant_turns_increment: 0 };
    const h = makeHarness();
    const { handle } = createStopHandler(h.pi, cfg);
    const ctx = h.ctx;

    await handle(eventWithTurns(10), ctx);
    await handle(eventWithTurns(10), ctx);
    expect(h.execCalls).toHaveLength(2);
  });

  test("silent gate resets baseline on compaction and stays silent until +N", async () => {
    const cfg = { ...DEFAULT_CONFIG, min_assistant_turns_increment: 10 };
    const h = makeHarness();
    const { handle, state } = createStopHandler(h.pi, cfg);
    const ctx = h.ctx;

    // First stop, 20 assistant turns >= N: review runs, baseline 20.
    await handle(eventWithTurns(20), ctx);
    expect(state.lastReviewCount.get("s1")).toBe(20);
    expect(h.execCalls).toHaveLength(1);

    // Compaction rewrote history down to 5 assistant turns: baseline resets
    // to 5 and the stop is silent (no review).
    const entriesBeforeReset = h.entries.length;
    await handle(eventWithTurns(5), ctx);
    expect(state.lastReviewCount.get("s1")).toBe(5);
    expect(h.execCalls).toHaveLength(1);
    expect(h.entries).toHaveLength(entriesBeforeReset);

    // 8 - 5 = 3 < N: still silent.
    await handle(eventWithTurns(8), ctx);
    expect(h.execCalls).toHaveLength(1);
    expect(h.entries).toHaveLength(entriesBeforeReset);

    // 15 - 5 = 10 >= N: review runs again, baseline moves to 15.
    await handle(eventWithTurns(15), ctx);
    expect(state.lastReviewCount.get("s1")).toBe(15);
    expect(h.execCalls).toHaveLength(2);
  });

  test("silent gate counts from session start and reviews only after >= N cumulative turns", async () => {
    const cfg = { ...DEFAULT_CONFIG, min_assistant_turns_increment: 10 };
    const h = makeHarness();
    const { handle, state } = createStopHandler(h.pi, cfg);
    const ctx = h.ctx;

    // First stop with few assistant turns (5 < N): silent, no baseline stored.
    await handle(eventWithTurns(5), ctx);
    expect(h.execCalls).toHaveLength(0);
    expect(state.lastReviewCount.get("s1")).toBeUndefined();

    // Cumulative turns from session start (12 - 0 >= N): review runs.
    await handle(eventWithTurns(12), ctx);
    expect(h.execCalls).toHaveLength(1);
    expect(state.lastReviewCount.get("s1")).toBe(12);

    // Only a little more (15 - 12 = 3 < N): silent again.
    await handle(eventWithTurns(15), ctx);
    expect(h.execCalls).toHaveLength(1);
    expect(state.lastReviewCount.get("s1")).toBe(12);
  });

  test("silent gate degrades to original flow when session_id is missing", async () => {
    const cfg = { ...DEFAULT_CONFIG, min_assistant_turns_increment: 10 };
    const h = makeHarness();
    const { handle, state } = createStopHandler(h.pi, cfg);
    const ctx = h.ctx;
    const missingSid = { ...eventWithTurns(20), session_id: "" };

    await handle(missingSid, ctx);
    await handle(missingSid, ctx);
    expect(state.lastReviewCount.size).toBe(0);
    expect(h.execCalls).toHaveLength(2);
  });

  test("need_user review notifies and allows end", async () => {
    const h = makeHarness({
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "need_user", reason: "请确认 API 选型" }),
              },
            ],
          },
        }),
        stderr: "",
      }),
    });
    const result = await h.handle(event(), h.ctx);
    expect(result).toBeUndefined();
    expect(h.notified).toEqual(["[delivery] 评审需要你确认：请确认 API 选型"]);
  });

  test("side-channel failures never throw (appendEntry/notify/logger)", async () => {
    const h = makeHarness({
      appendEntry: async () => {
        throw new Error("append failed");
      },
      logger: {
        info: () => {
          throw new Error("log failed");
        },
      },
    });
    const ctx = {
      ...h.ctx,
      ui: {
        notify: async () => {
          throw new Error("notify failed");
        },
      },
    };
    await expect(h.handle(event(), ctx)).resolves.toBeUndefined();
  });
});
