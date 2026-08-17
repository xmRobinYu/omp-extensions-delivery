/**
 * delivery — evidence packaging (FR-001/FR-002/FR-003).
 *
 * Builds two artifacts from the evidence window (the session's first
 * non-empty user message, prepended when it scrolled out of the recent
 * window, plus the most recent session messages):
 *  - plaintext: truncated, structured, human-readable evidence (what the review
 *    model reads; tool_result text stays readable);
 *  - archive:   gzip+base64 of the RAW window JSON (FR-003, appendEntry only —
 *    never sent to the model). When compression is disabled the archive is the
 *    raw JSON string itself.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import type { ContentBlock, SessionMessage, TextBlock } from "./types.ts";

export interface PackageOptions {
  /** How many of the most recent messages to package. */
  window: number;
  /** Per-message content truncation in the plaintext package (chars). */
  messageTruncateChars: number;
  /** Total plaintext package size cap (chars). */
  packageMaxChars: number;
  /** gzip+base64 the archived raw package when true, else store raw JSON. */
  compression: boolean;
}

export interface MessagePackage {
  /** Most recent non-empty user text (the current dev task). */
  userInput: string;
  /** Truncated structured plaintext evidence for the review model. */
  plaintext: string;
  /** Full JSON of the window (untruncated). */
  raw: string;
  /** gzip+base64 of raw (or raw itself when compression is disabled). */
  archive: string;
}

export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/** Concatenate the text content of a message's content blocks. */
export function blockText(content: ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is TextBlock =>
        !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

/** Most recent non-empty user text (skips empty trailing user messages). */
export function extractUserInput(messages: SessionMessage[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      const text = blockText(m.content).trim();
      if (text.length > 0) return text;
    }
  }
  return "";
}

/**
 * First non-empty user message in chronological order (the original dev
 * task). Uses the same non-empty semantics as extractUserInput (trimmed
 * block text must be non-empty). Returns undefined when no such message
 * exists.
 */
export function firstUserMessage(messages: SessionMessage[]): SessionMessage | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const m of messages) {
    if (m && m.role === "user") {
      const text = blockText(m.content).trim();
      if (text.length > 0) return m;
    }
  }
  return undefined;
}

/**
 * Render one message as a truncated, structured plaintext line.
 * tool_result evidence text (e.g. "3 failed") stays readable (AC-003).
 */
export function formatMessage(msg: SessionMessage, maxChars: number): string {
  if (!msg || typeof msg !== "object") return "";
  const head = `[${msg.role}]`;
  const lines: string[] = [];

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          if (typeof block.text === "string" && block.text) lines.push(block.text);
          break;
        case "thinking":
          if (typeof block.text === "string" && block.text) lines.push(`(thinking) ${block.text}`);
          break;
        case "toolCall": {
          const name = typeof block.name === "string" ? block.name : "?";
          const args =
            typeof block.arguments === "string"
              ? block.arguments
              : JSON.stringify(block.arguments ?? "");
          lines.push(`(toolCall) ${name} ${args}`);
          break;
        }
        default:
          if (typeof block.text === "string" && block.text) lines.push(`(${block.type}) ${block.text}`);
      }
    }
  }

  let body = lines.join("\n");
  if (msg.role === "toolResult" && typeof msg.toolName === "string") {
    const flag = msg.isError ? "error" : "ok";
    body = body
      ? `[toolResult:${msg.toolName}:${flag}] ${body}`
      : `[toolResult:${msg.toolName}:${flag}] (no text)`;
  }
  if (msg.role === "assistant" && typeof msg.stopReason === "string" && msg.stopReason) {
    body = body ? `${body}\n(stopReason: ${msg.stopReason})` : `(stopReason: ${msg.stopReason})`;
  }

  const rendered = body ? `${head} ${body}` : head;
  return truncate(rendered, maxChars);
}

/**
 * Package the evidence window: the session's first non-empty user message
 * (prepended to the front when it fell outside the recent window — long
 * sessions where the original task scrolled out) + the most recent
 * `opts.window` messages, kept in chronological order. When the first user
 * message is already inside the recent window it is NOT duplicated.
 */
export function packageMessages(messages: SessionMessage[], opts: PackageOptions): MessagePackage {
  const windowSize = Math.max(1, Math.floor(opts.window));
  const all = Array.isArray(messages) ? messages : [];
  const windowMsgs = all.slice(-windowSize);
  const firstUser = firstUserMessage(all);
  if (firstUser && !windowMsgs.includes(firstUser)) {
    // First non-empty user message fell outside the recent window — prepend
    // it so the review still sees the original dev task.
    windowMsgs.unshift(firstUser);
  }
  const raw = JSON.stringify(windowMsgs);

  const lines = windowMsgs
    .map((m) => formatMessage(m, opts.messageTruncateChars))
    .filter((l) => l.length > 0);
  const userInput =
    extractUserInput(windowMsgs) ||
    (firstUser ? blockText(firstUser.content).trim() : "");
  const userLine = userInput
    ? formatMessage(
        { role: "user", content: [{ type: "text", text: userInput }] },
        opts.messageTruncateChars,
      )
    : "";
  const cap = Math.max(0, Math.floor(opts.packageMaxChars));
  let plaintext: string;
  if (cap <= 0) {
    plaintext = "";
  } else if (!userLine) {
    plaintext = lines.join("\n").slice(-cap);
  } else if (userLine.length >= cap) {
    plaintext = truncate(userLine, cap);
  } else {
    const separator = 1;
    const remaining = cap - userLine.length - separator;
    const evidence = lines.filter((line) => line !== userLine).join("\n");
    const tail = remaining > 0 ? evidence.slice(-remaining) : "";
    plaintext = [userLine, tail].filter(Boolean).join("\n");
  }

  const archive = opts.compression
    ? gzipSync(Buffer.from(raw, "utf8")).toString("base64")
    : raw;

  return {
    userInput: extractUserInput(windowMsgs),
    plaintext,
    raw,
    archive,
  };
}

/**
 * Reverse of the archive encoding. Returns the raw package JSON string.
 * Tolerates plain (uncompressed) input — returns it unchanged.
 */
export function decompressArchive(data: string): string {
  try {
    const buf = Buffer.from(data, "base64");
    const out = gunzipSync(buf);
    return out.toString("utf8");
  } catch {
    return data; // not gzip+base64 — treat as plain
  }
}
