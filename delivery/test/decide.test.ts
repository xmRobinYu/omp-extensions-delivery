import { describe, expect, test } from "bun:test";
import { buildContinueContext, decide } from "../src/decide.ts";
import type { ReviewResult } from "../src/types.ts";

const done = (): ReviewResult => ({ status: "done", reason: "全部通过" });
const cont = (): ReviewResult => ({
  status: "continue",
  reason: "请补充回归测试",
  summary: "请修复测试覆盖率",
});
const needUser = (): ReviewResult => ({
  status: "need_user",
  reason: "API 选型存在歧义",
});

describe("decide", () => {
  test("done always ends the session", () => {
    expect(decide(done(), 2, 3)).toEqual({ action: "done" });
    expect(decide(done(), 3, 3)).toEqual({ action: "done" });
  });

  test("need_user always ends", () => {
    expect(decide(needUser(), 0, 3)).toEqual({ action: "need_user" });
    expect(decide(needUser(), 5, 3)).toEqual({ action: "need_user" });
  });

  test("continue returns feedback while under the soft cap", () => {
    const d = decide(cont(), 0, 3);
    expect(d.action).toBe("continue");
    if (d.action !== "continue") throw new Error("expected continue");
    expect(d.additionalContext).toContain("第 1 轮");
    expect(d.additionalContext).toContain("请补充回归测试");
    expect(d.additionalContext).toContain("请修复测试覆盖率");
  });

  test("continue rounds count already-issued continues (0 before first)", () => {
    // Default max=3: roundsDone 0,1,2 -> continue; 3 -> need_user (FR-010).
    expect(decide(cont(), 0, 3).action).toBe("continue");
    expect(decide(cont(), 1, 3).action).toBe("continue");
    expect(decide(cont(), 2, 3).action).toBe("continue");
    const cap = decide(cont(), 3, 3);
    expect(cap.action).toBe("need_user");
    expect(decide(cont(), 99, 3).action).toBe("need_user");
  });
});

describe("buildContinueContext", () => {
  test("omits empty summary", () => {
    const c = buildContinueContext({ status: "continue", reason: "重试" }, 2);
    expect(c).toContain("第 2 轮");
    expect(c).toContain("重试");
    expect(c).not.toContain("摘要：");
  });
});
