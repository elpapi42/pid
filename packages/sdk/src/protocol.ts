import type { Activity, AuthEvent, ErrorInfo } from "./types.js";
export const VERSION = 1;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_QUEUE_BYTES = 32 * 1024 * 1024;
export const MAX_QUEUE_ITEMS = 1024;
export const COMMANDS = [
  "health",
  "harness.start",
  "harness.list",
  "harness.stop",
  "harness.destroy",
  "conversation.create",
  "conversation.list",
  "send",
  "watch",
  "unwatch",
  "compact",
  "abort",
  "auth.login",
  "auth.answer",
  "auth.cancel",
] as const;
export type Command = (typeof COMMANDS)[number];
export type Request = {
  v: 1;
  id: string;
  instance?: string;
  command: Command;
  args: Record<string, unknown>;
};
export type Frame =
  | {
      v: 1;
      instance: string;
      type: "response";
      id: string;
      result?: unknown;
      error?: ErrorInfo;
    }
  | {
      v: 1;
      instance: string;
      type: "activity";
      subscriptionId: string;
      activity: Activity;
    }
  | {
      v: 1;
      instance: string;
      type: "subscription.end";
      subscriptionId: string;
      error?: ErrorInfo;
    }
  | {
      v: 1;
      instance: string;
      type: "auth.event";
      id: string;
      event: AuthEvent;
    }
  | {
      v: 1;
      instance: string;
      type: "auth.prompt";
      id: string;
      promptId: string;
      prompt: unknown;
    }
  | {
      v: 1;
      instance: string;
      type: "auth.prompt.cancel";
      id: string;
      promptId: string;
    };
export class PidError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PidError";
  }
  toJSON(): ErrorInfo {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
export function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof PidError) return error.toJSON();
  const name = error instanceof Error ? error.name : "";
  const codes: Record<string, string> = {
    ConversationBusy: "conversation_busy",
    ConversationIdle: "conversation_idle",
    ReadOnlySession: "harness_stopped",
    SessionFailed: "storage_failed",
  };
  return {
    code: codes[name] ?? "operation_failed",
    message: error instanceof Error ? error.message : "Operation failed",
  };
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PidError("invalid_request", "Expected an object");
  return value as Record<string, unknown>;
}
export function textField(value: unknown, name: string, max = 65536): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw new PidError("invalid_request", `Invalid ${name}`);
  return value;
}
export function idField(value: unknown, name = "conversationId"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new PidError("invalid_request", `Invalid ${name}`);
  return value as number;
}
export function optionalBoolean(value: unknown, name: string): boolean {
  if (value !== undefined && typeof value !== "boolean")
    throw new PidError("invalid_request", `Invalid ${name}`);
  return value === true;
}
export function encode(value: unknown): Buffer {
  const buffer = Buffer.from(JSON.stringify(value));
  if (buffer.length > MAX_FRAME_BYTES)
    throw new PidError(
      "frame_too_large",
      "Protocol frame exceeds the size limit",
    );
  return buffer;
}
export function decode(buffer: Buffer): Record<string, unknown> {
  if (buffer.length > MAX_FRAME_BYTES)
    throw new PidError(
      "frame_too_large",
      "Protocol frame exceeds the size limit",
    );
  try {
    return record(JSON.parse(buffer.toString("utf8")));
  } catch {
    throw new PidError("invalid_frame", "Invalid JSON protocol frame");
  }
}
export function parseRequest(buffer: Buffer): Request {
  const value = decode(buffer);
  if (value.v !== VERSION)
    throw new PidError("protocol_mismatch", "Unsupported PID protocol version");
  const id = textField(value.id, "request id", 128);
  if (!COMMANDS.includes(value.command as Command))
    throw new PidError("invalid_request", "Unknown command");
  if (value.instance !== undefined) textField(value.instance, "instance", 128);
  return {
    v: VERSION,
    id,
    command: value.command as Command,
    args: record(value.args),
    instance: value.instance as string | undefined,
  };
}
