# @elpapi42/pid-sdk

TypeScript SDK for a local, shared Pi Durable daemon. The SDK includes the compiled private daemon, LMDB, ZeroMQ, and pinned native Pi packages. The CLI is a separate package and is not required.

Requires Linux, Node.js 22.19 or later, systemd user services, and util-linux `/usr/bin/flock`. The package name is configured for this MVP and has not been published.

```ts
import { connect, startDaemon } from "@elpapi42/pid-sdk";

await startDaemon(); // Explicit persistent systemd setup and readiness check.
const client = await connect();
try {
  const harness = await client.harnesses.start("/path/to/project", { name: "worker" });
  const conversation = await client.conversations.create(harness.id, {
    model: "openrouter/openai/gpt-4.1-nano",
  });
  const activity = await client.watch(harness.id, { conversationId: conversation.id });
  const reading = (async () => {
    for await (const item of activity) console.log(JSON.stringify(item));
  })();
  try {
    const receipt = await client.send(harness.id, conversation.id, "Inspect the project", {
      requestId: "my-operation-1",
      wait: true,
    });
    console.log(receipt.settlement?.status);
  } finally {
    await activity.close();
    await reading;
  }
} finally {
  await client.close();
}
```

An independent client can use an existing ID or name without creating the harness:

```ts
const client = await connect();
try {
  const page = await client.conversations.list("worker");
  await client.send("worker", page.items[0]!.id, "Continue");
} finally {
  await client.close();
}
```

`connect()` never starts the daemon. Imports and package installation have no service side effects. `startDaemon({ stateDir?, timeoutMs? })` saves service configuration and checks readiness. `connect({ timeoutMs? })` changes the ordinary RPC timeout, which defaults to 30 seconds. Wait operations have no completion timeout and still detect connection loss.

## API

| Method | Arguments and result |
| --- | --- |
| `harnesses.start(ref, { name? }?)` | Directory, existing ID, or name. Returns desired and observed state. Relative paths use the caller's directory. |
| `harnesses.list()` | All declared harnesses, observed states, and errors. |
| `harnesses.stop(ref)` | Persist stopped intent, close runtime, preserve data. |
| `harnesses.destroy(ref)` | Persist absent intent, delete managed data, unregister after cleanup. |
| `conversations.create(ref, { model })` | New conversation with `provider/model`. |
| `conversations.create(ref, { fork, at?, model? })` | Native fork, latest entry by default, inherited model unless overridden. |
| `conversations.list(ref, { limit?, cursor? }?)` | `{ items, next? }`, including stopped harnesses. Default page size 50, maximum 500. |
| `send(ref, conversationId, message, options?)` | `{ submissionId, requestId, settlement? }`. |
| `watch(ref, { conversationId? }?)` | Acknowledged async iterable with `close()`. |
| `compact(ref, conversationId, { instructions?, wait? }?)` | `{ taskId, outcome?, settlement? }`. |
| `abort(ref, conversationId, { background? }?)` | Abort native work, optionally including background tasks. |
| `auth.login(provider, interaction)` | Native authentication, returning `{ provider, type }`. |
| `close()` | Close this client's connection and subscriptions. |

Harness IDs have six random lowercase letters or digits, with collision retries. Names are unique. Conversation, entry, task, and submission IDs are native positive integers scoped to a harness. Tool call and request IDs are strings.

Send options are `requestId?`, `whenBusy?: "follow-up" | "steer" | "reject"`, `whenIdle?: "run" | "reject"`, and `wait?: boolean`. Defaults are follow-up, run, and no wait. Use the same request ID and message when retrying an uncertain submission. A `delivery_uncertain` error includes the request ID. PID does not retry mutations automatically. Native submission and task settlement types are retained in receipts.

`PidError` has `code`, `message`, optional `details`, and `toJSON()`. A failed lifecycle command can leave accepted desired intent in place. List harnesses to inspect convergence. Reconnect explicitly after a daemon restart or a lost connection.

## Authentication

```ts
await client.auth.login("openrouter", {
  notify(event) { /* Show structured authorization instructions. */ },
  async prompt(prompt) {
    // Return selected option ID, entered text, or secret.
    // Respect prompt.signal if input is canceled.
    return readInputFromYourApplication(prompt);
  },
  signal: abortController.signal,
});
```

Prompt types are `text`, `secret`, `manual_code`, and `select`. Event types are `info`, `progress`, `auth_url`, and `device_code`. The daemon owns private persistent credentials and serializes updates and refreshes. Applications must keep prompt answers out of their logs.

The daemon supplies the provider with the app name `PID` and one stable installation UUID saved in `auth/.device-id`. OpenAI account login requires that host identity. The UUID persists across daemon restarts and is separate from the LMDB harness registry.

## Activity

Each object has `type`, `conversationId`, and type-specific fields:

| Type | Fields |
| --- | --- |
| `thinking`, `assistant_message`, `user_message` | `entryId`, `index`, `text` |
| `image` | `index`, `source`, `mimeType`, `base64`, available `entryId` or `callId` |
| `tool_call` | `callId`, `name`, `arguments`, optional `parentCallId` |
| `tool_result` | `callId`, optional `text`, `error`, `truncated: true` |
| `error` | `code`, `message`, optional `taskId` |

Parts are complete native commits, not tokens. Redacted thinking and provider signatures are omitted. Tool images precede the closing tool result. Internal prompts and compaction summaries are omitted. Watching a harness includes extension-created conversations.

There is no activity persistence, replay, or durable cursor. Each subscription has a bounded buffer of 1,024 items or 32 MiB. Slow consumers receive `activity_overflow`. Transport loss ends the subscription. Closing a subscription or client leaves accepted work running. Native transcript storage remains persistent and can grow.

Extensions load from `<cwd>/.pid/extensions/` as native default exports. Files are sorted, and supported suffixes are `.js`, `.mjs`, `.ts`, and `.mts`. Native package imports share the SDK's pinned runtime. Restart the daemon after extension edits. All harnesses share the daemon process and its failure boundary.

Stopped metadata reads pause execution but require a writable SQLite connection for Pi Durable 1.5.2 initialization bookkeeping. No tasks resume during those reads.
