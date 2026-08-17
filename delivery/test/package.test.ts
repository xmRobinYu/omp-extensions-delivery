import { describe, expect, test } from "bun:test";
import {
  decompressArchive,
  extractUserInput,
  formatMessage,
  packageMessages,
  truncate,
} from "../src/package.ts";
import type { SessionMessage } from "../src/types.ts";

const user = (text: string): SessionMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});
const tool = (text: string, toolName = "test", isError = false): SessionMessage => ({
  role: "toolResult",
  content: [{ type: "text", text }],
  toolName,
  isError,
});

const opts = {
  window: 20,
  messageTruncateChars: 8000,
  packageMaxChars: 100_000,
  compression: true,
};

describe("truncate", () => {
  test("boundary behavior", () => {
    expect(truncate("abc", 2)).toBe("ab");
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abc", 0)).toBe("");
  });
});

describe("extractUserInput", () => {
  test("most recent non-empty user text wins", () => {
    const msgs = [user("first"), tool("out"), user(""), user("latest request")];
    expect(extractUserInput(msgs)).toBe("latest request");
  });
  test("empty when no non-empty user message", () => {
    expect(extractUserInput([tool("x"), user("")])).toBe("");
    expect(extractUserInput([])).toBe("");
    expect(extractUserInput(undefined as never)).toBe("");
  });
});

describe("packageMessages", () => {
  test("tool_result evidence string is readable in plaintext (AC-003)", () => {
    const pkg = packageMessages([user("run tests"), tool("3 failed, 0 passed")], opts);
    expect(pkg.plaintext).toContain("3 failed");
    expect(pkg.plaintext).toContain("toolResult");
    expect(pkg.plaintext).toContain("run tests");
  });

  test("per-message truncation boundary respected", () => {
    const msgs = [user("x".repeat(20_000))];
    const pkg = packageMessages(msgs, { ...opts, messageTruncateChars: 100 });
    // One line per message: the user line must be <= 100 chars.
    const userLine = pkg.plaintext.split("\n")[0];
    expect(userLine.length).toBeLessThanOrEqual(100);
  });

  test("total package cap respected", () => {
    const msgs = Array.from({ length: 20 }, (_, i) =>
      tool(`message ${i} ` + "y".repeat(500)),
    );
    const pkg = packageMessages(msgs, { ...opts, packageMaxChars: 1000 });
    expect(pkg.plaintext.length).toBeLessThanOrEqual(1000);
    // Keeps the tail (most recent evidence).
    expect(pkg.plaintext).toContain("message 19");
  });

  test("tiny cap keeps userInput first and total within cap", () => {
    const userInput = "Fix the failing build";
    const msgs = [
      user(userInput),
      ...Array.from({ length: 20 }, (_, i) =>
        tool(`huge ${i} ` + "x".repeat(5000)),
      ),
    ];
    const pkg = packageMessages(msgs, {
      ...opts,
      window: 50,
      messageTruncateChars: 1000,
      packageMaxChars: 200,
    });
    expect(pkg.plaintext.startsWith(`[user] ${userInput}`)).toBe(true);
    expect(pkg.plaintext.length).toBeLessThanOrEqual(200);
  });

  test("window = first non-empty user message (if outside) + most recent N", () => {
    const msgs = [
      tool("warmup"),
      tool("warmup2"),
      user("old"),
      user("middle"),
      user("new"),
    ];
    const pkg = packageMessages(msgs, { ...opts, window: 2 });
    // First user message ("old") is outside the recent-2 window -> prepended.
    expect(pkg.plaintext).toContain("old");
    expect(pkg.plaintext).toContain("middle");
    expect(pkg.plaintext).toContain("new");
    // Non-user messages before the first user are dropped.
    expect(pkg.plaintext).not.toContain("warmup");
    expect(pkg.userInput).toBe("new");
  });

  test("first user outside window: prepended, userInput falls back to it (long session)", () => {
    const firstUserText = "Build the thing";
    const msgs = [
      user(firstUserText),
      ...Array.from({ length: 24 }, (_, i) => tool(`result ${i}`)),
    ];
    const pkg = packageMessages(msgs, opts); // 25 messages, window 20
    expect(pkg.userInput).toBe(firstUserText);
    const parsed = JSON.parse(decompressArchive(pkg.archive)) as SessionMessage[];
    expect(parsed).toHaveLength(21); // 1 prepended user + 20 recent
    expect(parsed[0]).toEqual(user(firstUserText));
    expect(pkg.plaintext).toContain(firstUserText);
  });

  test("first user inside window: not duplicated, window's last user text wins", () => {
    const msgs = [
      tool("pre"),
      user("original task"),
      ...Array.from({ length: 18 }, (_, i) => tool(`r${i}`)),
      user("latest request"),
    ];
    const pkg = packageMessages(msgs, opts); // 21 messages, window 20
    expect(pkg.userInput).toBe("latest request");
    const parsed = JSON.parse(decompressArchive(pkg.archive)) as SessionMessage[];
    expect(parsed).toHaveLength(20); // no duplication
    expect(parsed[0]).toEqual(user("original task"));
    const userTexts = parsed
      .filter((m) => m.role === "user")
      .map((m) => (m.content[0] as { text: string }).text);
    expect(userTexts).toEqual(["original task", "latest request"]);
  });

  test("no user messages -> empty userInput and plain window", () => {
    const msgs = Array.from({ length: 25 }, (_, i) => tool(`r${i}`));
    const pkg = packageMessages(msgs, opts);
    expect(pkg.userInput).toBe("");
    const parsed = JSON.parse(decompressArchive(pkg.archive)) as SessionMessage[];
    expect(parsed).toHaveLength(20); // just the recent window, nothing to prepend
  });

  test("empty first user message skipped; next non-empty user used", () => {
    const msgs = [
      user("   "),
      user("real task"),
      ...Array.from({ length: 23 }, (_, i) => tool(`r${i}`)),
    ];
    const pkg = packageMessages(msgs, opts); // 25 messages, window 20
    expect(pkg.userInput).toBe("real task");
    const parsed = JSON.parse(decompressArchive(pkg.archive)) as SessionMessage[];
    expect(parsed).toHaveLength(21);
    expect(parsed[0]).toEqual(user("real task"));
    expect(pkg.plaintext).toContain("real task");
  });

  test("userInput preserved", () => {
    const pkg = packageMessages([user("Build the thing"), tool("All tests passed")], opts);
    expect(pkg.userInput).toBe("Build the thing");
    expect(pkg.plaintext).toContain("Build the thing");
  });

  test("gzip archive round-trips to the raw package", () => {
    const msgs = [user("hello"), tool("ok")];
    const pkg = packageMessages(msgs, opts);
    expect(pkg.archive).not.toContain("hello"); // compressed, not readable
    expect(decompressArchive(pkg.archive)).toBe(pkg.raw);
    expect(JSON.parse(decompressArchive(pkg.archive))).toEqual(msgs);
  });

  test("compression disabled -> archive is raw JSON text", () => {
    const msgs = [user("hi")];
    const pkg = packageMessages(msgs, { ...opts, compression: false });
    expect(pkg.archive).toBe(pkg.raw);
    expect(decompressArchive(pkg.archive)).toBe(pkg.raw);
  });
});

describe("formatMessage", () => {
  test("assistant toolCall/thinking blocks are rendered", () => {
    const msg: SessionMessage = {
      role: "assistant",
      content: [
        { type: "thinking", text: "hmm" },
        { type: "toolCall", name: "bash", arguments: "bun test" },
        { type: "text", text: "done" },
      ],
    };
    const line = formatMessage(msg, 5000);
    expect(line).toContain("[assistant]");
    expect(line).toContain("toolCall");
    expect(line).toContain("bash");
    expect(line).toContain("bun test");
    expect(line).toContain("done");
  });

  test("toolResult isError flag visible", () => {
    const line = formatMessage(tool("boom", "test", true), 5000);
    expect(line).toContain("error");
    expect(line).toContain("boom");
  });

  test("unknown/non-object input -> empty", () => {
    expect(formatMessage(null as never, 10)).toBe("");
  });
});
