import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("defaults when raw is null/undefined/not an object", () => {
    expect(loadConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(loadConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(loadConfig("nope")).toEqual(DEFAULT_CONFIG);
    expect(loadConfig(42)).toEqual(DEFAULT_CONFIG);
  });

  test("applies valid numeric overrides", () => {
    const cfg = loadConfig({
      max_trigger_tokens: 5,
      context_window_messages: 3,
      max_continue_rounds: 1,
      min_assistant_turns_increment: 3,
      review_timeout_seconds: 9,
    });
    expect(cfg.max_trigger_tokens).toBe(5);
    expect(cfg.context_window_messages).toBe(3);
    expect(cfg.max_continue_rounds).toBe(1);
    expect(cfg.min_assistant_turns_increment).toBe(3);
    expect(cfg.review_timeout_seconds).toBe(9);
  });

  test("rejects non-finite or negative numbers -> defaults kept", () => {
    const cfg = loadConfig({
      max_trigger_tokens: "100",
      max_review_tokens: NaN,
      review_timeout_seconds: Infinity,
      message_truncate_chars: -5,
      package_max_chars: Number.POSITIVE_INFINITY,
      min_assistant_turns_increment: -1,
    });
    expect(cfg.max_trigger_tokens).toBe(DEFAULT_CONFIG.max_trigger_tokens);
    expect(cfg.max_review_tokens).toBe(DEFAULT_CONFIG.max_review_tokens);
    expect(cfg.review_timeout_seconds).toBe(DEFAULT_CONFIG.review_timeout_seconds);
    expect(cfg.message_truncate_chars).toBe(DEFAULT_CONFIG.message_truncate_chars);
    expect(cfg.package_max_chars).toBe(DEFAULT_CONFIG.package_max_chars);
    expect(cfg.min_assistant_turns_increment).toBe(DEFAULT_CONFIG.min_assistant_turns_increment);
  });

  test("zero window value is clamped to 1", () => {
    expect(loadConfig({ context_window_messages: 0 }).context_window_messages).toBe(1);
  });

  test("review_model requires a non-empty trimmed string", () => {
    expect(loadConfig({ review_model: "  " }).review_model).toBe(DEFAULT_CONFIG.review_model);
    expect(loadConfig({ review_model: "" }).review_model).toBe(DEFAULT_CONFIG.review_model);
    expect(loadConfig({ review_model: 7 }).review_model).toBe(DEFAULT_CONFIG.review_model);
    expect(loadConfig({ review_model: "  a/b/c  " }).review_model).toBe("a/b/c");
  });

  test("enable_compression accepts booleans only", () => {
    expect(loadConfig({ enable_compression: false }).enable_compression).toBe(false);
    expect(loadConfig({ enable_compression: "yes" }).enable_compression).toBe(true);
  });

  test("enable_tui_review defaults false and accepts booleans only", () => {
    expect(DEFAULT_CONFIG.enable_tui_review).toBe(false);
    expect(loadConfig({}).enable_tui_review).toBe(false);
    expect(loadConfig({ enable_tui_review: true }).enable_tui_review).toBe(true);
    expect(loadConfig({ enable_tui_review: false }).enable_tui_review).toBe(false);
    expect(loadConfig({ enable_tui_review: "yes" }).enable_tui_review).toBe(false);
  });

  test("min_assistant_turns_increment defaults to 10 and accepts 0", () => {
    expect(DEFAULT_CONFIG.min_assistant_turns_increment).toBe(10);
    expect(loadConfig({}).min_assistant_turns_increment).toBe(10);
    expect(loadConfig({ min_assistant_turns_increment: 0 }).min_assistant_turns_increment).toBe(0);
  });
});
