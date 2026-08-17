/**
 * delivery — shared type definitions.
 * Mirrors the verified omp extension API surface (probe-verified shapes).
 * These are minimal structural types; the harness provides the real objects.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface OtherBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type ContentBlock = TextBlock | OtherBlock;

export interface UserMessage {
  role: "user";
  content: ContentBlock[];
  timestamp?: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  model?: string;
  usage?: unknown;
  stopReason?: unknown;
  timestamp?: string;
}

export interface ToolResultMessage {
  role: "toolResult";
  content: ContentBlock[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  details?: unknown;
  timestamp?: string;
}

export type SessionMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface SessionStopEvent {
  messages: SessionMessage[];
  last_assistant_message?: unknown;
  session_id?: string;
  turn_id?: string;
  stop_hook_active?: boolean;
  /** AbortSignal for the session_stop handler; aborting must stop subprocesses. */
  signal?: AbortSignal;
}

/** Options accepted by DeliveryPi.exec (mirrors the omp harness exec surface). */
export interface ExecOpts {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
}

export interface ContextUsage {
  tokens: number;
  contextWindow?: number;
  percent?: number;
}

/** Display-only message pushed into the session message stream. */
export interface CustomMessagePayload {
  customType: string;
  content: string;
  display?: boolean;
  attribution?: "agent" | "user";
  details?: unknown;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed?: boolean;
}

export interface ReviewResult {
  status: "done" | "continue" | "need_user";
  reason: string;
  summary?: string;
}

export interface DeliveryModels {
  resolve(spec: string): Promise<unknown>;
  current(): Promise<unknown>;
  list(): Promise<unknown[]>;
}

export interface DeliveryUi {
  notify(message: string): void | Promise<void>;
}

export interface DeliveryCtx {
  hasUI: boolean;
  getContextUsage(): ContextUsage | Promise<ContextUsage>;
  models: DeliveryModels;
  ui?: DeliveryUi;
  /** Managed timers from the omp ExtensionContext (auto-cleared on teardown). */
  setTimeout?(fn: () => void, ms?: number): unknown;
  clearTimer?(handle: unknown): unknown;
}

export interface DeliveryPi {
  exec(cmd: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;
  appendEntry(type: string, data: unknown): void | Promise<void>;
  logger?: {
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
    error?(...args: unknown[]): void;
  };
  sendUserMessage?(...args: unknown[]): unknown;
  sendMessage?(
    message: CustomMessagePayload,
    options?: {
      triggerTurn?: boolean;
      deliverAs?: "steer" | "followUp" | "nextTurn";
    },
  ): unknown;
  registerMessageRenderer?(type: string, renderer: unknown): unknown;
}

export interface ContinueResponse {
  continue: true;
  additionalContext: string;
}

export interface ExtensionAPI extends DeliveryPi {
  on(
    event: "session_stop",
    handler: (
      event: SessionStopEvent,
      ctx: DeliveryCtx,
    ) => ContinueResponse | Promise<ContinueResponse | void> | void,
  ): unknown;
}

declare module "./config.ts" {
  interface DeliveryConfig {
    [key: string]: unknown;
  }
}
