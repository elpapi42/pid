import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";
import type {
  Activity,
  AuthEvent,
  CompactReceipt,
  ConversationPage,
  ErrorInfo,
  HarnessInfo,
  SendReceipt,
} from "@elpapi42/pid-sdk";

/** Agent and project text must not control the user's terminal. JSON keeps the original data. */
export function plain(value: unknown): string {
  return stripVTControlCharacters(String(value)).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    "",
  );
}
function cell(value: unknown): string {
  return plain(value).replace(/[\n\t]/g, " ");
}
export async function line(
  value: string,
  stream: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  if (!stream.write(value + "\n")) await once(stream, "drain");
}
export function table(headers: string[], rows: unknown[][]): string {
  const values = [headers, ...rows.map((row) => row.map(cell))];
  const widths = headers.map((_, index) =>
    Math.max(...values.map((row) => row[index]?.length ?? 0)),
  );
  return values
    .map((row) =>
      row
        .map((value, index) =>
          index === row.length - 1 ? value : value.padEnd(widths[index]!),
        )
        .join("  "),
    )
    .join("\n");
}
export function harnessList(items: HarnessInfo[]): string {
  if (!items.length) return "No harnesses. Start one with: pid harness start .";
  const errors = items.some((item) => item.error);
  return table(
    [
      "ID",
      "NAME",
      "DESIRED",
      "ACTUAL",
      "DIRECTORY",
      ...(errors ? ["ERROR"] : []),
    ],
    items.map((item) => [
      item.id,
      item.name ?? "-",
      item.desired,
      item.actual,
      item.cwd,
      ...(errors ? [item.error?.message ?? "-"] : []),
    ]),
  );
}
export function harnessResult(
  action: "start" | "stop" | "destroy",
  item: HarnessInfo,
): string {
  if (action === "destroy")
    return `Harness ${plain(item.id)} destroyed. The project directory and shared credentials were preserved.`;
  return `Harness ${plain(item.id)}${item.name ? ` (${plain(item.name)})` : ""} is ${plain(item.actual)} in ${plain(item.cwd)}.`;
}
export function shellArgument(value: string): string {
  return /^[a-zA-Z0-9_./:-]+$/.test(value)
    ? value
    : "'" + value.replace(/'/g, "'\\''") + "'";
}
export function conversations(page: ConversationPage, ref: string): string {
  const rows = page.items.map((item) => [
    item.id,
    item.model ?? "-",
    item.parent
      ? `${item.parent.conversationId} at entry ${item.parent.at}`
      : "-",
  ]);
  const body = rows.length
    ? table(["ID", "MODEL", "FORKED FROM"], rows)
    : "No conversations. Create one with --model <provider/model>.";
  return (
    body +
    (page.next
      ? `\nMore: pid conversation list ${plain(shellArgument(ref))} --cursor ${plain(shellArgument(page.next))}`
      : "")
  );
}
export function sent(receipt: SendReceipt): string {
  const identity = `Submission ${receipt.submissionId} (request ${plain(receipt.requestId)})`;
  if (!receipt.settlement)
    return `${identity} accepted. Use pid watch to see live activity.`;
  return receipt.settlement.status === "done"
    ? `${identity} completed.`
    : `${identity} ended without an answer: ${plain(receipt.settlement.reason)}.`;
}
export function compacted(receipt: CompactReceipt): string {
  if (!receipt.outcome) return `Compaction task ${receipt.taskId} accepted.`;
  if (receipt.outcome.status !== "completed")
    return `Compaction task ${receipt.taskId} ${plain(receipt.outcome.status)}: ${plain(receipt.outcome.error?.message ?? receipt.outcome.reason ?? "no summary was placed")}.`;
  if (receipt.settlement?.status === "unanswered")
    return `Compaction task ${receipt.taskId} completed, but its summary was not placed: ${plain(receipt.settlement.reason)}.`;
  return `Compaction task ${receipt.taskId} completed${receipt.settlement ? " and its summary was placed" : ""}.`;
}
export function activity(item: Activity): string {
  const prefix = `[conversation ${item.conversationId}]`;
  switch (item.type) {
    case "thinking":
      return `${prefix} Thinking\n${plain(item.text)}`;
    case "user_message":
      return `${prefix} User\n${plain(item.text)}`;
    case "assistant_message":
      return `${prefix} Assistant\n${plain(item.text)}`;
    case "tool_call":
      return `${prefix} Tool call: ${plain(item.name)} (${plain(item.callId)})${item.parentCallId ? `, parent ${plain(item.parentCallId)}` : ""}\n${plain(JSON.stringify(item.arguments))}`;
    case "tool_result":
      return `${prefix} Tool result: ${plain(item.callId)}${item.error ? `, error ${plain(item.error.code)}: ${plain(item.error.message)}` : ""}${item.truncated ? " [truncated]" : ""}${item.text ? `\n${plain(item.text)}` : ""}`;
    case "image":
      return `${prefix} Image from ${item.source}: ${plain(item.mimeType)}, ${Buffer.byteLength(item.base64, "base64")} bytes${item.callId ? ` (tool ${plain(item.callId)})` : ""}. Use --json for image data.`;
    case "error":
      return `${prefix} Error [${plain(item.code)}]${item.taskId ? ` in task ${item.taskId}` : ""}: ${plain(item.message)}`;
  }
}
export function authEvent(event: AuthEvent): string {
  switch (event.type) {
    case "auth_url":
      return `Open this URL in your browser:\n${plain(event.url)}${event.instructions ? `\n${plain(event.instructions)}` : ""}`;
    case "device_code":
      return `Open ${plain(event.verificationUri)} and enter code ${plain(event.userCode)}.`;
    default:
      return (
        plain(event.message) +
        (event.links
          ?.map(
            (link) =>
              `\n${link.label ? plain(link.label) + ": " : ""}${plain(link.url)}`,
          )
          .join("") ?? "")
      );
  }
}
export function failure(detail: ErrorInfo): string {
  const hints: Record<string, string> = {
    daemon_unavailable: "Start the daemon with: pid daemon start",
    connection_lost:
      "Reconnect to the daemon. Accepted work can still be running.",
    daemon_restarted:
      "Run the command again to reconnect. Use the same request ID when retrying a message.",
    harness_not_found: "List registered harnesses with: pid harness list",
    harness_stopped: "Start the harness with: pid harness start <id|name>",
    harness_destroying:
      "Deletion is pending. Inspect the harness with: pid harness list",
    reconcile_failed:
      "Desired state remains saved. Inspect progress with: pid harness list",
    model_required:
      "Use --model <provider/model>, or --fork <conversation> to inherit a model.",
    invalid_argument: "Run pid <command> --help for usage and examples.",
    unknown_command: "Run pid --help to see available commands.",
    activity_overflow:
      "Subscribe again with pid watch. Activity has no replay.",
    auth_failed: "Check the provider and try pid auth login <provider> again.",
  };
  const request =
    detail.code === "delivery_uncertain" &&
    detail.details &&
    typeof detail.details === "object" &&
    "requestId" in detail.details
      ? `\nRequest ID: ${plain(detail.details.requestId)}. Retry the same message with --request-id and this ID.`
      : "";
  return `Error [${plain(detail.code)}]: ${plain(detail.message)}${request}${hints[detail.code] ? `\n${hints[detail.code]}` : ""}`;
}
