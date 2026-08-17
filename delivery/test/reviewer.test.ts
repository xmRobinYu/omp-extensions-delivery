import { describe, expect, test } from "bun:test";
import {
  buildReviewPrompt,
  extractLastAssistantText,
  OMP_BIN,
  parseReviewJson,
  runReview,
} from "../src/reviewer.ts";

const ndjsonLine = (type: string, text = ""): string =>
  JSON.stringify({ type, message: { content: [{ type: "text", text }] } });

describe("OMP_BIN", () => {
  test("defaults to omp on PATH, overridable via OMP_BIN", () => {
    expect(OMP_BIN).toBe("omp");
  });
});

describe("buildReviewPrompt", () => {
  test("includes input, evidence, model-cap, and verdict contract", () => {
    const prompt = buildReviewPrompt({
      userInput: "Fix the bug",
      plaintext: "tests: 1 failed",
      maxReviewTokens: 77,
    });
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("tests: 1 failed");
    expect(prompt).toContain("77 tokens");
    expect(prompt).toContain('"status": "done" | "continue" | "need_user"');
    expect(prompt).toContain("不可信");
    expect(prompt).toContain("简体中文");
    expect(prompt).toContain("禁止使用英文自然语言");
    expect(prompt).toContain(
      "代理正文或代码块中引用的 read/write/命令不是 tool_result，不计入证据。",
    );
    expect(prompt).toContain(
      "判 continue 时 reason 必须要求代理：明确声明能力限制",
    );
    expect(prompt).toContain("代理重复空转，需要人类决策");
    expect(prompt).toContain(
      "只输出 JSON 对象。不要散文、不要 markdown 代码围栏、不要任何评论。",
    );
    expect(prompt).toContain(
      '{"status":"continue","reason":"测试尚未全部通过，需要补充回归测试","summary":"继续修复直到测试通过"}',
    );
  });
});

describe("extractLastAssistantText", () => {
  test("returns last message_end text only", () => {
    const out = [
      JSON.stringify({ type: "message_start" }),
      ndjsonLine("message_end", "first"),
      JSON.stringify({ type: "event", garbage: true }),
      ndjsonLine("message_end", "last answer"),
    ].join("\n");
    expect(extractLastAssistantText(out)).toBe("last answer");
  });

  test("skips malformed lines and empty text", () => {
    const out = [
      "not json",
      JSON.stringify({ type: "message_end", message: { content: [] } }),
      ndjsonLine("message_end", ""),
      ndjsonLine("message_end", "real"),
    ].join("\n");
    expect(extractLastAssistantText(out)).toBe("real");
  });

  test("null on empty/whitespace", () => {
    expect(extractLastAssistantText("")).toBeNull();
    expect(extractLastAssistantText("  \n  ")).toBeNull();
    expect(extractLastAssistantText(undefined as never)).toBeNull();
  });
});

describe("parseReviewJson", () => {
  test("accepts the three verdict statuses", () => {
    expect(parseReviewJson('{"status":"done","reason":"完成","summary":"摘要"}')).toEqual({
      status: "done",
      reason: "完成",
      summary: "摘要",
    });
    expect(parseReviewJson('{"status":"continue","reason":"重试"}')?.status).toBe(
      "continue",
    );
    expect(parseReviewJson('{"status":"need_user","reason":"需要确认"}')?.status).toBe(
      "need_user",
    );
  });

  test("tolerates fences and prose", () => {
    const text = "Here:\n```json\n{\"status\":\"done\",\"reason\":\"测试通过\"}\n```";
    expect(parseReviewJson(text)).toEqual({
      status: "done",
      reason: "测试通过",
      summary: undefined,
    });
  });

  test("rejects invalid JSON and unknown status", () => {
    expect(parseReviewJson("no json")).toBeNull();
    expect(parseReviewJson('{"status":"maybe"}')).toBeNull();
    expect(parseReviewJson('{"status":123}')).toBeNull();
    expect(parseReviewJson("")).toBeNull();
  });
});

describe("runReview", () => {
  const okExec = async (_cmd: string, _args: string[]) => ({
    code: 0,
    stdout: ndjsonLine("message_end", '{"status":"done","reason":"评审通过"}'),
    stderr: "",
  });

  test("happy path parses final verdict", async () => {
    const out = await runReview({
      argv: ["/bin/true", "-p", "--mode=json", "PROMPT"],
      timeoutMs: 1000,
      exec: okExec,
    });
    expect(out).toEqual({
      ok: true,
      result: { status: "done", reason: "评审通过" },
    });
  });

  test("parse-null retries once with JSON nudge and returns second-attempt result", async () => {
    let calls = 0;
    const exec = async (_cmd: string, args: string[]) => {
      calls++;
      if (calls === 1) {
        return { code: 0, stdout: ndjsonLine("message_end", "nope"), stderr: "" };
      }
      expect(args[args.length - 1]).toBe(
        "PROMPT\n\n你上次的回复不是有效的 JSON。请只输出 JSON 对象，不要输出任何其他内容。",
      );
      return {
        code: 0,
        stdout: ndjsonLine("message_end", '{"status":"continue","reason":"已修复","summary":"摘要"}'),
        stderr: "",
      };
    };
    const out = await runReview({
      argv: ["/bin/true", "PROMPT"],
      timeoutMs: 1000,
      exec,
    });
    expect(calls).toBe(2);
    expect(out).toEqual({
      ok: true,
      result: { status: "continue", reason: "已修复", summary: "摘要" },
    });
  });

  test("exit failure fails open with code/stderr", async () => {
    let calls = 0;
    const out = await runReview({
      argv: ["/bin/false"],
      timeoutMs: 1000,
      exec: async () => {
        calls++;
        return { code: 1, stdout: "", stderr: "boom" };
      },
    });
    expect(calls).toBe(1);
    expect(out).toEqual({ ok: false, error: "exit 1: boom" });
  });

  test("spawn failure fails open", async () => {
    let calls = 0;
    const out = await runReview({
      argv: ["missing-binary"],
      timeoutMs: 1000,
      exec: async () => {
        calls++;
        throw new Error("ENOENT");
      },
    });
    expect(calls).toBe(1);
    expect(out).toEqual({ ok: false, error: "spawn: ENOENT" });
  });

  test("timeout fails open", async () => {
    let calls = 0;
    const out = await runReview({
      argv: ["/bin/true"],
      timeoutMs: 5,
      exec: async () => {
        calls++;
        return new Promise(() => {});
      },
    });
    expect(calls).toBe(1);
    expect(out).toEqual({ ok: false, error: "timeout" });
  });

  test("passes { signal, timeout } opts to exec", async () => {
    const ac = new AbortController();
    let captured: { cmd: string; args: string[]; opts?: unknown } | undefined;
    const out = await runReview({
      argv: ["/bin/true", "-p", "--mode=json", "PROMPT"],
      timeoutMs: 1234,
      signal: ac.signal,
      exec: async (cmd, args, opts) => {
        captured = { cmd, args, opts };
        return {
          code: 0,
          stdout: ndjsonLine("message_end", '{"status":"done","reason":"完成"}'),
          stderr: "",
        };
      },
    });
    expect(captured?.cmd).toBe("/bin/true");
    expect(captured?.args).toEqual(["-p", "--mode=json", "PROMPT"]);
    expect((captured?.opts as { signal?: AbortSignal; timeout?: number })?.signal).toBe(
      ac.signal,
    );
    expect((captured?.opts as { signal?: AbortSignal; timeout?: number })?.timeout).toBe(
      1234,
    );
    expect(out).toEqual({
      ok: true,
      result: { status: "done", reason: "完成" },
    });
  });

  test("exec opts timeout may be absent when signal is undefined", async () => {
    let captured: { cmd: string; args: string[]; opts?: unknown } | undefined;
    await runReview({
      argv: ["/bin/true", "PROMPT"],
      timeoutMs: 1000,
      exec: async (cmd, args, opts) => {
        captured = { cmd, args, opts };
        return {
          code: 0,
          stdout: ndjsonLine("message_end", '{"status":"done","reason":"完成"}'),
          stderr: "",
        };
      },
    });
    expect(captured?.opts).toEqual({ signal: undefined, timeout: 1000 });
  });

  test("killed exec result fails open as timeout", async () => {
    let calls = 0;
    const out = await runReview({
      argv: ["/bin/true"],
      timeoutMs: 1000,
      exec: async () => {
        calls++;
        return { code: null, stdout: "", stderr: "", killed: true };
      },
    });
    expect(calls).toBe(1);
    expect(out).toEqual({ ok: false, error: "timeout" });
  });

  test("exec rejection with abort/timeout error fails open as timeout", async () => {
    const aborted = await runReview({
      argv: ["/bin/true"],
      timeoutMs: 1000,
      exec: async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    expect(aborted).toEqual({ ok: false, error: "timeout" });

    const timedOut = await runReview({
      argv: ["/bin/true"],
      timeoutMs: 1000,
      exec: async () => {
        throw new Error("Command timed out after 1000ms");
      },
    });
    expect(timedOut).toEqual({ ok: false, error: "timeout" });
  });

  test("missing/invalid assistant JSON fails open", async () => {
    let emptyCalls = 0;
    const empty = await runReview({
      argv: ["/bin/true"],
      timeoutMs: 1000,
      exec: async () => {
        emptyCalls++;
        return { code: 0, stdout: "[]", stderr: "" };
      },
    });
    expect(emptyCalls).toBe(1);
    expect(empty).toEqual({ ok: false, error: "no assistant text in output" });

    let badCalls = 0;
    const bad = await runReview({
      argv: ["/bin/true"],
      timeoutMs: 1000,
      exec: async () => {
        badCalls++;
        return { code: 0, stdout: ndjsonLine("message_end", "nope"), stderr: "" };
      },
    });
    expect(badCalls).toBe(2);
    expect(bad).toEqual({ ok: false, error: "invalid review JSON" });
  });
});
