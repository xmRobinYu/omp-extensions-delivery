/**
 * delivery — config loading & validation.
 * Reads ./config.json next to this module; all fields have defaults.
 * Never mutates any omp/session config.
 */

export interface DeliveryConfig {
  /** Review model spec, resolved via ctx.models.resolve(). */
  review_model: string;
  /** Skip review (fail-open) when context usage percent exceeds this (0-100). */
  max_trigger_percent: number;
  /** Skip review (fail-open) when percent is unavailable and ctx.getContextUsage().tokens exceeds this. */
  max_trigger_tokens: number;
  /** Cap for the review subprocess model output (informational; prompt enforces). */
  max_review_tokens: number;
  /** How many of the most recent session messages to package. */
  context_window_messages: number;
  /** gzip+base64 the archived raw message package (archive only, never sent to model). */
  enable_compression: boolean;
  /** TUI sessions run archive+review+continue when true; FR-014 skip when false. */
  enable_tui_review: boolean;
  /** Kill switch for the review subprocess (seconds); fail-open on timeout. */
  review_timeout_seconds: number;
  /** Soft cap on consecutive continue rounds; beyond it -> need_user. */
  max_continue_rounds: number;
  /** Minimum new assistant turns since the last review before another review runs; 0 disables the gate. */
  min_assistant_turns_increment: number;
  /** Per-message content truncation in the plaintext package (chars). */
  message_truncate_chars: number;
  /** Total plaintext package size cap (chars). */
  package_max_chars: number;
}

export const DEFAULT_CONFIG: DeliveryConfig = {
  review_model: "deepseek-proxy/deepseek-v4-flash",
  max_trigger_percent: 90,
  max_trigger_tokens: 500_000,
  max_review_tokens: 10_000,
  context_window_messages: 20,
  enable_compression: true,
  enable_tui_review: false,
  review_timeout_seconds: 60,
  max_continue_rounds: 3,
  min_assistant_turns_increment: 10,
  message_truncate_chars: 8_000,
  package_max_chars: 100_000,
};

const NUMERIC_KEYS = [
  "max_trigger_percent",
  "max_trigger_tokens",
  "max_review_tokens",
  "context_window_messages",
  "review_timeout_seconds",
  "max_continue_rounds",
  "min_assistant_turns_increment",
  "message_truncate_chars",
  "package_max_chars",
] as const;

export function loadConfig(raw: unknown): DeliveryConfig {
  const cfg: DeliveryConfig = { ...DEFAULT_CONFIG };
  if (raw == null || typeof raw !== "object") return cfg;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.review_model === "string" && obj.review_model.trim().length > 0) {
    cfg.review_model = obj.review_model.trim();
  }
  if (typeof obj.enable_compression === "boolean") {
    cfg.enable_compression = obj.enable_compression;
  }
  if (typeof obj.enable_tui_review === "boolean") {
    cfg.enable_tui_review = obj.enable_tui_review;
  }
  for (const key of NUMERIC_KEYS) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      (cfg as Record<string, number>)[key] = v;
    }
  }
  // max_trigger_percent must stay within 0-100; out-of-range falls back to default.
  if (cfg.max_trigger_percent > 100) cfg.max_trigger_percent = DEFAULT_CONFIG.max_trigger_percent;
  // Sanity: window/messages caps must be >= 1 where meaningful.
  if (cfg.context_window_messages < 1) cfg.context_window_messages = 1;
  if (cfg.max_continue_rounds < 0) cfg.max_continue_rounds = 0;
  return cfg;
}
