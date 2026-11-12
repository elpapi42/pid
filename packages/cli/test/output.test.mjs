import test from "node:test";
import assert from "node:assert/strict";
import {
  activity,
  authEvent,
  failure,
  harnessList,
  conversations,
} from "../dist/output.js";

test("human activity renders every type, preserves linkage, and blocks terminal control sequences", () => {
  const unsafe =
    "visible\u001b[31m red\u001b[0m\u001b]52;c;c2VjcmV0\u0007\r\u0000";
  const image = Buffer.from("private-image-bits").toString("base64");
  const items = [
    { type: "thinking", conversationId: 2, entryId: 3, index: 0, text: unsafe },
    {
      type: "assistant_message",
      conversationId: 2,
      entryId: 3,
      index: 1,
      text: unsafe,
    },
    {
      type: "user_message",
      conversationId: 2,
      entryId: 1,
      index: 0,
      text: unsafe,
    },
    {
      type: "tool_call",
      conversationId: 2,
      callId: "parent/child",
      parentCallId: "parent",
      name: "echo",
      arguments: { text: unsafe },
    },
    {
      type: "tool_result",
      conversationId: 2,
      callId: "parent/child",
      text: unsafe,
      error: { code: "tool_failed", message: unsafe },
      truncated: true,
    },
    {
      type: "image",
      conversationId: 2,
      index: 1,
      source: "tool",
      mimeType: "image/png",
      callId: "parent/child",
      base64: image,
    },
    {
      type: "error",
      conversationId: 2,
      code: "generation_failed",
      message: unsafe,
      taskId: 4,
    },
  ];
  for (const item of items) {
    const text = activity(item);
    assert.match(text, /conversation 2/);
    assert.ok(!text.includes("\u001b"));
    assert.ok(!text.includes("\u0000"));
    assert.ok(!text.includes("\r"));
  }
  assert.match(activity(items[3]), /parent\/child.*parent parent/);
  assert.match(activity(items[4]), /tool_failed.*\[truncated\]/);
  assert.ok(!activity(items[5]).includes(image));
  assert.match(activity(items[5]), /--json/);
  assert.match(activity(items[6]), /task 4/);
});

test("human metadata keeps desired state, errors, pagination, and recovery guidance visible", () => {
  const text = harnessList([
    {
      id: "abc123",
      cwd: "/tmp/project\nforged-row",
      desired: "running",
      actual: "error",
      error: { code: "storage_failed", message: "Database unavailable" },
    },
  ]);
  assert.match(text, /DESIRED.*ACTUAL/);
  assert.match(text, /running.*error.*Database unavailable/);
  assert.ok(!text.includes("\nforged-row"));
  assert.match(harnessList([]), /pid harness start/);
  assert.match(
    conversations({ items: [], next: "cursor" }, "a'; echo unsafe"),
    /--cursor cursor/,
  );
  assert.match(
    failure({ code: "daemon_unavailable", message: "No daemon" }),
    /pid daemon start/,
  );
  assert.match(
    failure({
      code: "delivery_uncertain",
      message: "Unknown",
      details: { requestId: "stable-1" },
    }),
    /stable-1.*--request-id/,
  );
  assert.match(
    authEvent({
      type: "auth_url",
      url: "https://example.com/auth",
      instructions: "Complete sign-in",
    }),
    /https:\/\/example.com\/auth.*\nComplete sign-in/,
  );
  assert.match(
    authEvent({
      type: "device_code",
      userCode: "ABCD",
      verificationUri: "https://example.com/device",
    }),
    /ABCD/,
  );
});
