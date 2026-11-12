import type {
  CommitPublication,
  EntryRecord,
} from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import type { Activity, ErrorInfo } from "../types.js";
type Call = {
  conversationId: number;
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  parentCallId?: string;
};
const object = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
/** Projects stored native commits only. It has no activity storage or history scan. */
export class Activities {
  private nested = new Map<
    number,
    Call & {
      resultSent?: true;
    }
  >();
  private failures = new Set<string>();
  constructor(
    private readonly emit: (activity: Activity) => void,
    private readonly overflow: () => void,
  ) {}
  private error(
    conversationId: number,
    taskId: number | undefined,
    code: string,
    message: string,
  ): void {
    const key = createHash("sha256")
      .update(`${conversationId}:${taskId}:${code}:${message}`)
      .digest("hex");
    if (this.failures.has(key)) return;
    this.failures.add(key);
    if (this.failures.size > 1024)
      this.failures.delete(this.failures.values().next().value!);
    this.emit({
      type: "error",
      conversationId,
      code,
      message,
      ...(taskId ? { taskId } : {}),
    });
  }
  private result(
    call: Pick<Call, "conversationId" | "callId">,
    content: unknown,
    isError: boolean,
    diagnostics: any[] = [],
    details?: unknown,
    entryId?: number,
  ): void {
    const identity = {
      conversationId: call.conversationId,
      callId: call.callId,
    };
    let parts: any[];
    if (typeof content === "string") parts = [{ type: "text", text: content }];
    else if (Array.isArray(content)) parts = content;
    else if (object(content)?.type === "image") parts = [content];
    else
      parts =
        content === undefined
          ? []
          : [{ type: "text", text: JSON.stringify(content) }];
    const texts: string[] = [];
    for (const [index, part] of parts.entries()) {
      if (part?.type === "text" && typeof part.text === "string")
        texts.push(part.text);
      if (
        part?.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      ) {
        this.emit({
          type: "image",
          ...identity,
          ...(entryId ? { entryId } : {}),
          index,
          source: "tool",
          mimeType: part.mimeType,
          base64: part.data,
        });
      }
    }
    const diagnostic = diagnostics.find((value) => value?.severity === "error");
    const error: ErrorInfo | undefined = isError
      ? {
          code: diagnostic?.code ?? "tool_failed",
          message: diagnostic?.message ?? "Tool call failed",
        }
      : undefined;
    const truncated =
      diagnostics.some(
        (value) =>
          typeof value?.code === "string" && value.code.includes("truncat"),
      ) || object(details)?.truncated === true;
    this.emit({
      type: "tool_result",
      ...identity,
      ...(texts.length ? { text: texts.join("\n") } : {}),
      ...(error ? { error } : {}),
      ...(truncated ? { truncated: true } : {}),
    });
  }
  private entry(entry: EntryRecord): void {
    if (entry.kind === "pi.system" || entry.kind === "pi.compaction") return;
    let index = 0;
    for (const message of entry.model ?? []) {
      if (message.role === "system") continue;
      if (message.role === "toolResult") {
        this.result(
          { conversationId: entry.conversationId, callId: message.toolCallId },
          message.content,
          message.isError,
          object(entry.data)?.diagnostics,
          message.details,
          entry.id,
        );
        continue;
      }
      const content =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;
      for (const part of content) {
        const position = index++;
        if (part.type === "text" && part.text)
          this.emit({
            type:
              message.role === "user" ? "user_message" : "assistant_message",
            conversationId: entry.conversationId,
            entryId: entry.id,
            index: position,
            text: part.text,
          });
        else if (part.type === "thinking" && !part.redacted && part.thinking)
          this.emit({
            type: "thinking",
            conversationId: entry.conversationId,
            entryId: entry.id,
            index: position,
            text: part.thinking,
          });
        else if (part.type === "image")
          this.emit({
            type: "image",
            conversationId: entry.conversationId,
            entryId: entry.id,
            index: position,
            source: message.role === "user" ? "user" : "assistant",
            mimeType: part.mimeType,
            base64: part.data,
          });
        else if (part.type === "toolCall")
          this.emit({
            type: "tool_call",
            conversationId: entry.conversationId,
            callId: part.id,
            name: part.name,
            arguments: part.arguments,
          });
      }
    }
  }
  advance(publication: CommitPublication): void {
    // Publications do not promise change order. Build nested-call linkage before results, and retire it last.
    const retired: number[] = [];
    for (const change of publication.changes) {
      if (change.type !== "task" || change.value.kind !== "pi.tool") continue;
      const task = change.value;
      const input = object(task.input);
      if (input?.kind !== "nested") continue;
      const nativeCall = object(input.call);
      if (!nativeCall) continue;
      const call: Call = {
        conversationId: task.conversationId,
        callId: nativeCall.id,
        name: nativeCall.name,
        arguments: nativeCall.arguments,
        parentCallId: input.parentCallId,
      };
      if (
        !this.nested.has(task.id) &&
        task.state.status !== "terminal" &&
        task.state.status !== "completing"
      )
        this.emit({ type: "tool_call", ...call });
      if (!this.nested.has(task.id)) this.nested.set(task.id, call);
      if (task.state.status === "terminal") retired.push(task.id);
    }
    for (const entry of publication.changes
      .filter((change) => change.type === "entry")
      .map((change) => change.value)
      .sort((a, b) => a.id - b.id))
      this.entry(entry);
    for (const change of publication.changes) {
      if (
        change.type !== "document" ||
        change.kind !== "change" ||
        change.conversationId === undefined
      )
        continue;
      const value = change.value as Record<string, any>;
      if (change.record.kind === "pi.live") {
        if (value.runFailure) {
          const failure = value.runFailure;
          this.error(
            change.conversationId,
            failure.taskId,
            failure.reason,
            failure.detail ?? failure.reason,
          );
        }
        if (value.compactionFailure) {
          const failure = value.compactionFailure;
          this.error(
            change.conversationId,
            failure.taskId,
            "compaction_failed",
            failure.error,
          );
        }
      }
      if (change.record.kind === "pi.tool.nested-call" && value.result) {
        const call = this.nested.get(value.taskId);
        if (call && !call.resultSent) {
          this.result(
            call,
            value.result.structuredOutput,
            value.result.isError,
            value.result.diagnostics,
            value.result.details,
          );
          call.resultSent = true;
        }
      }
    }
    for (const id of retired) {
      const call = this.nested.get(id);
      const task = publication.changes.find(
        (change) => change.type === "task" && change.value.id === id,
      );
      if (
        call &&
        !call.resultSent &&
        task?.type === "task" &&
        task.value.state.status === "terminal" &&
        task.value.state.outcome.status !== "completed"
      ) {
        const outcome = task.value.state.outcome;
        this.emit({
          type: "tool_result",
          conversationId: call.conversationId,
          callId: call.callId,
          error: {
            code: outcome.status,
            message: "Nested tool did not complete",
          },
        });
      }
      this.nested.delete(id);
    }
    if (this.nested.size > 10000) {
      this.nested.clear();
      this.overflow();
    }
  }
  close(): void {
    this.nested.clear();
    this.failures.clear();
  }
}
