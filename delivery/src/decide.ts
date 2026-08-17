/**
 * delivery — verdict mapping (FR-007/FR-008/FR-009/FR-010).
 *
 *   done      -> allow the session to end (record + notify).
 *   continue  -> while the soft cap is not exhausted, return
 *                { continue: true, additionalContext } with review feedback;
 *                beyond the cap escalate to need_user (FR-010).
 *   need_user -> notify the user and allow the session to end (FR-009).
 *
 * Review subprocess failures never reach this module (fail-open upstream).
 */
import type { ReviewResult } from "./types.ts";

export type Decision =
  | { action: "done" }
  | { action: "continue"; additionalContext: string }
  | { action: "need_user" };

/** Feedback injected into the model context when the review says "continue". */
export function buildContinueContext(result: ReviewResult, round: number): string {
  const summary = result.summary ? `\n- 摘要：${result.summary}` : "";
  return [
    `[delivery] 独立评审（第 ${round} 轮）判定任务尚未完成。`,
    `- 原因：${result.reason}`,
    summary,
    "请针对上述问题继续工作，重跑测试/验证，直到任务真正完成。",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

/**
 * @param roundsDone        number of consecutive continues ALREADY issued
 *                          (0 before the first review).
 * @param maxContinueRounds soft cap from config (default 3).
 *                          Continue while roundsDone < cap (FR-010: 超限转 need_user).
 */
export function decide(
  result: ReviewResult,
  roundsDone: number,
  maxContinueRounds: number,
): Decision {
  if (result.status === "done") return { action: "done" };
  if (result.status === "need_user") return { action: "need_user" };
  // status === "continue"
  if (roundsDone < maxContinueRounds) {
    return {
      action: "continue",
      additionalContext: buildContinueContext(result, roundsDone + 1),
    };
  }
  return { action: "need_user" };
}
