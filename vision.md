PID — Headless Pi Durable Runtime

MVP Technical Specification

1. Overview

PID is a lightweight, local-first, unopinionated control plane for "Pi Durable" (https://github.com/earendil-works/pi), inspired by "pi-fleet" (https://github.com/elpapi42/pi-fleet).

It manages multiple persistent Pi Durable harnesses, exposing them through a shared CLI ("pid") and TypeScript SDK.

Harnesses run directly inside one daemon process, recover automatically after daemon crashes or machine reboots, and can be accessed concurrently by multiple independent clients.

Core principle: Build reusable agent execution infrastructure, not another agent application.

2. Architecture

Three components:

- Daemon: Long-running local service reconciling desired harness state, hosting Pi Durable instances, routing execution, and streaming activity over ZeroMQ.
- SDK: TypeScript interface for harness management and conversation interaction.
- CLI ("pid"): Thin wrapper around the SDK, exposing the same essential operations.

The CLI uses the SDK for every operation. It does not access storage, communicate with the daemon, or host Pi Durable independently of the SDK.

Communication

SDK-to-daemon communication uses ZeroMQ exclusively, with local "ipc://" endpoints.

- SDK clients communicate with the daemon through ZeroMQ. The CLI is an SDK client.
- The daemon calls its hosted Pi Durable harnesses directly in the same process. No daemon-to-harness transport is required.
- Multiple clients can interact with and observe the same harness concurrently.
- Support request/response operations and streaming subscriptions.
- No HTTP, WebSockets, or alternate transports in v1.

Ordinary SDK commands use request-response and return one result or error. A command with "wait: true" waits for its native completion or settlement without blocking unrelated commands or clients. Requests and replies carry correlation IDs, allowing concurrent commands and subscriptions on one connection.

"watch" subscribes and receives an acknowledgment before exposing its async iterable of live activities. Authentication may exchange interaction requests and answers before its final result. The SDK's daemon-start operation performs local service setup before the daemon can accept requests, then checks readiness through its endpoint.

The daemon is the sole writable owner of every hosted Pi Durable runtime. Each harness has its own storage and extension registry.

The MVP runs one daemon per OS user. Clients discover a fixed, private per-user ZeroMQ IPC endpoint independent of the daemon's state directory. Only "pid daemon start" accepts "--state-dir". The OS service configuration preserves that location across restarts and reboots. Connected clients do not select a state directory or open LMDB.

Harnesses share one process and failure boundary. A fatal process failure interrupts all hosted harnesses. A blocking extension can stall the daemon and every harness. Individual harnesses cannot be forcibly terminated independently of the daemon.

3. Desired State — LMDB

Reuse pi-fleet's "lmdb" npm package, atomic-write patterns, and restrictive directory permissions. PID uses a smaller, daemon-owned desired-state registry.

References: "store.ts" (https://github.com/elpapi42/pi-fleet/blob/master/packages/sdk/src/state/store.ts), "client.ts" (https://github.com/elpapi42/pi-fleet/blob/master/packages/sdk/src/fleet/client.ts), "control.ts" (https://github.com/elpapi42/pi-fleet/blob/master/packages/sdk/src/worker/control.ts).

PID storage layout

Default:

~/.pid/
├── data.mdb
├── lock.mdb
├── harnesses/
│   └── <harness-id>/
│       └── session.sqlite
└── auth/

- LMDB: Desired harness configuration, owned exclusively by the daemon.
- SQLite: Isolated Pi Durable storage for each harness.
- IPC: The daemon's fixed endpoint lives in a private per-user runtime directory, separate from state storage.
- Auth: Persistent pi-ai credentials, kept separate from registry metadata.

Only the daemon opens LMDB and Pi Durable storage. The SDK requests state and operations through ZeroMQ. The CLI accesses them through the SDK.

Configuration resolution:

1. Explicit "pid daemon start --state-dir <path>".
2. The location already saved in the OS service configuration.
3. "~/.pid" for first setup.

An explicit different location conflicts with an already running daemon and returns "state_dir_conflict". When the service is stopped, an explicit location can replace its saved configuration without moving or deleting previous data. Automatic data migration and multiple daemons for one user are outside MVP scope. Only the SDK's "startDaemon" bootstrap accepts "stateDir"; connected clients have no state-directory option. "PID_STATE_DIR" is not a client configuration mechanism.

Paths are canonicalized. Relative harness paths resolve from the SDK or CLI caller's current directory. The state directory and IPC runtime directory must have restrictive local permissions.

Minimal registry schema

Each harness record contains:

type HarnessSpec = {
  cwd: string;
  name?: string;
  desired: "running" | "stopped" | "absent";
};

LMDB layout:

- Root metadata: "schemaVersion" = 1.
- One named database, "harnesses": harness ID -> HarnessSpec.

The record key is the stable harness ID. The daemon maintains name and canonical-cwd indexes in memory and rebuilds them from LMDB at startup. Names and canonical working directories are unique. A name cannot equal another harness's ID. Generated IDs are checked against registered IDs and names before atomic registration, and collisions cause regeneration. Registration and desired-state changes use atomic LMDB transactions.

Observed state stays in memory: "starting", "running", "stopping", "stopped", "destroying", or "error", with an optional last error. "running" means the harness is open and available, even if its conversations are idle. List and lifecycle responses include the desired configuration and observed state. Runtime IDs, generations, endpoints, timestamps, messages, activity, and credentials are not part of HarnessSpec.

"SDK harnesses.list()" sends a ZeroMQ request to the daemon. The daemon reads the LMDB harness records, adds current observed state and errors, and returns the result. The SDK never opens the database. Listing requires a reachable daemon; an unavailable daemon returns an explicit error rather than triggering direct client storage access.

An OS process-lifetime lock at the fixed per-user runtime location establishes exclusive daemon ownership across state directories. The Linux implementation uses util-linux "/usr/bin/flock --no-fork" and Node's "process.execve" to retain the daemon PID and kernel lock. A stale process ID, endpoint, or LMDB record is not proof of ownership.

4. Harness Management

Each harness:

- Has a stable ID, optional name, and working directory.
- Runs as a Pi Durable instance directly inside the daemon process.
- Owns isolated Pi Durable storage.
- Supports multiple conversations.
- Automatically loads Durable-native extensions from "<cwd>/.pid/extensions/".
- Uses pi-ai for provider configuration and authentication.
- Recovers unfinished tasks through Pi Durable's persistence mechanisms.

The "<cwd>/.pid/" directory is reserved for project-local PID files. It is separate from the daemon's state directory, which defaults to "~/.pid/". Only extension loading from ".pid/extensions/" is in the initial scope. Built-in system prompt and skills loading may use this reserved directory in the future, but are out of scope for MVP.

No built-in system prompt, skills loader, or "AGENTS.md" loader is required.

Users supply these capabilities through extensions.

Extension files load in sorted filename order directly from ".pid/extensions/". Supported suffixes are ".js", ".mjs", ".ts", and ".mts", excluding TypeScript declaration files. Each file default-exports one native Durable extension or an array. TypeScript uses Node-supported erasable syntax. Native "@earendil-works/*" imports resolve through the installed SDK's pinned runtime packages, including in projects without an npm installation. Other dependencies use normal Node resolution. Extension code changes require a daemon restart because Node caches imports.

Lifecycle

- Starting a new directory registers its desired configuration with "desired: running".
- Starting an existing harness ID or name sets "desired: running" again.
- Stopping a harness sets "desired: stopped".
- Destroying a harness sets "desired: absent".
- A daemon reconciler serializes lifecycle work per harness and opens, closes, or deletes managed data until observed state matches the latest desired configuration. Recoverable failures retry with backoff, and their errors remain visible.
- Lifecycle commands persist intent first, then wait for convergence. A failure or timeout returns an explicit error while preserving the desired state for reconciliation. A caller timeout does not roll back accepted intent.
- Daemon process failure triggers automatic service restart and recovery of running harnesses.
- On daemon restart, all harnesses with "desired: running" are restored.
- Explicitly stopped harnesses remain stopped.
- A harness marked absent remains recorded until its runtime is closed and its managed data is deleted. Only then is the record removed. A crash resumes unfinished deletion. A start request for that harness is rejected while deletion is pending.
- Destroying a harness preserves the user's working directory, including project-local ".pid/" files, and shared provider credentials.
- Execution requests to a stopped or destroying harness fail instead of changing its desired state.

This is a small desired-state reconciler. The MVP does not add manifests, infrastructure planning, resource graphs, or a separate configuration language.

The daemon must be launched automatically after machine reboot through OS service integration.

Two recovery layers:

- The OS service manager restarts the daemon, and PID reopens harnesses marked running.
- Pi Durable recovers conversations, tasks, and execution state.

5. CLI Specification

Executable: "pid".

The CLI is human-first. Commander defines commands, validates arguments, and generates command-specific help and examples. Inquirer supplies terminal text input, arrow-key selection, and hidden secret input. The CLI still uses the public SDK for every operation.

Every command accepts the optional global "--json" flag, before or after its command path. Human output is the default, including when redirected. "--json" selects structured machine output and disables terminal UI, colors, and progress decoration. "pid --help", "pid <command> --help", "pid help <command>", and "pid --version" are human-readable by default and also accept "--json".

Daemon

pid daemon start [--state-dir <path>]

Starts or ensures the local daemon and its boot-time service integration.

It resolves and saves the state location, installs or updates the OS service, enables boot startup and restart, starts the daemon, and waits for readiness. If the matching daemon already runs, it checks readiness and returns. Service setup failures and harness recovery failures are explicit. The command exits while the daemon stays running.

Harnesses

pid harness start <path|id|name> [--name <name>]
pid harness list
pid harness stop <harness>
pid harness destroy <harness>

"start" is idempotent. Harnesses have no model setting or model default. "stop" preserves execution data. "destroy" reconciles to absence before unregistering the harness. A harness reference accepts its ID or name.

Conversations

pid conversation create <harness> --model <provider/model>
pid conversation create <harness> --fork <conversation> [--model <provider/model>]
pid conversation create <harness> --fork <conversation> --at <entry> [--model <provider/model>]

pid conversation list <harness> [--limit <n>] [--cursor <token>]

Models are configured per conversation. A new conversation receives its model through the SDK creation options or CLI "--model" flag. Pi Durable persists that model in its native per-conversation agent configuration in the harness's SQLite database. LMDB contains no model or conversation records.

Forking inherits the parent's transcript and applicable agent configuration, including its model, using Pi Durable's native fork mechanism. An explicit "--model" overrides the model on the new fork only.

When "--at" is omitted, use the latest committed entry.

"SDK conversations.list(harnessId)" sends a ZeroMQ request to the daemon. The daemon resolves the harness and scans Pi Durable's stored conversation records and per-conversation model configuration. It includes persisted forks and extension-created conversations. The result is a page with "items" and an optional opaque "next" cursor:

type ConversationSummary = {
  id: number;
  model?: string; // provider/model, omitted if native configuration has no model.
  parent?: { conversationId: number; at: number };
};

type ConversationPage = {
  items: ConversationSummary[];
  next?: string;
};

Pagination reuses native conversation scanning. It lists metadata without loading or returning transcripts or replaying activities. No separate conversation index or activity database is added to LMDB.

For a running harness, the daemon reads through its existing runtime. For a stopped harness, it uses non-executing native read-only access to the existing database, then closes that reader. Listing does not resume tasks or change the desired state. Reads are coordinated with lifecycle work, and a destroying harness rejects listing. A missing or unreadable database returns an explicit error instead of creating replacement storage.

Pi Durable 1.5.2 implementation constraint: "Harness.open({ readOnly: true })" pauses execution, but the SQLite initializer still writes migration bookkeeping. Stopped metadata listing therefore requires filesystem write permission even though it does not mutate conversations or schedule work.

Sending instructions

pid send <harness> <conversation> <message>

pid send <harness> <conversation> <message> \
  [--when-busy <follow-up|steer|reject>] \
  [--when-idle <run|reject>] \
  [--request-id <id>] \
  [--wait]

Defaults:

- "--when-busy follow-up"
- "--when-idle run"
- "--wait" disabled

Without "--wait", return the durable submission ID. With it, wait for settlement. The SDK accepts a caller request ID, and "pid send" also supports "--request-id <id>" for explicit safe retries.

Activity streaming

pid watch <harness> [--conversation <id>]

Stream normalized live agent activity from all conversations in the harness, including conversations created by extensions. The optional flag filters one conversation. The SDK exposes the same stream as an async iterable. The CLI renders readable, labeled activity by default. With "--json", it writes exactly one unchanged JSON activity object per stdout line. Human rendering removes terminal control sequences and describes images without printing their base64 data. The activity contract is the same in both modes.

Use native stored-commit observation for messages, thinking, images, tool intents, and tool results. Observe creations inside the runtime as well as SDK-created conversations. Native committed failure state supplies execution-error activities. Internal snapshots establish the adapter's baseline and are not sent to clients. Prompt documents, registry snapshots, daemon logs, and transport notifications are not agent activity. The MVP does not stream tokens or partial message updates.

Activity contract:

Each activity is a flat JSON object with "type", "conversationId", and fields specific to its supported type:

| Type | Type-specific fields |
| --- | --- |
| "thinking" | "entryId", "index", "text" |
| "assistant_message" | "entryId", "index", "text" |
| "user_message" | "entryId", "index", "text" |
| "image" | "index", "source" (user, assistant, or tool), "mimeType", "base64", and available "entryId" or "callId" |
| "tool_call" | "callId", "name", "arguments", optional "parentCallId" |
| "tool_result" | "callId", optional "text", optional "error: { code, message }", optional "truncated: true" |
| "error" | "code", "message", optional "taskId" |

The harness comes from the subscription. There is no generic "data" envelope, generic "id", per-event version, content array, or status field. The transport protocol negotiates compatibility when the SDK connects. Conversation, entry, and task IDs retain their native numeric representation. Native entry IDs associate the thinking, text, and images from one message. The zero-based "index" identifies each part's position in its native content. Native string tool call IDs associate an invocation with its result, including images. Nested calls use "parentCallId".

Emit each complete text, thinking, or image part once after its native entry is committed, in native content order. A message with readable thinking, text, and an image produces three activities. A user message is emitted when it becomes a committed transcript entry; queued admission still returns its submission ID through "send". Native tool intent and result commits produce distinct "tool_call" and "tool_result" activities. A tool call records a request to invoke a tool and does not imply execution has started. "tool_result" closes the call, with an error if it failed, was aborted, or was interrupted. Native retained output may be truncated, which is marked explicitly. Tool-result text parts are combined into "text". Images are emitted separately with "callId" before the closing "tool_result" activity. Nested tool activity comes from native committed task state when no transcript entry exists.

Thinking contains only readable reasoning text exposed by the provider. If no readable text is available, no thinking activity is emitted. Provider signatures, encrypted reasoning payloads, and redacted text are not exported or decoded. An assistant-message activity describes a committed model response part and does not mean the whole agent run is complete. Standalone generation or compaction failures emit "error" activities so clients can observe failed work without a generic lifecycle/status protocol.

Activities are transient notifications, not updates to stored activity items. PID never writes activity objects or activity history to LMDB, SQLite, or a journal file. It keeps bounded subscriber buffers and bounded processing state in memory and releases delivered activity. Slow or interrupted subscribers cannot cause unbounded activity retention.

The feed starts at subscription, has ordered delivery per subscription, and has no conversation replay, history replay, or durable cursor. A disconnected or overflowing subscription ends with a structured error instead of silently dropping activity or reconnecting across an unknown gap. A new subscription observes new live activity. Activity delivery has no durable transaction or exactly-once guarantee, and activity can be lost on interruption.

Pi Durable still persists its native transcript, task checkpoints, and configured live-progress documents for execution recovery and forks. Those native databases can grow with conversation history. Keeping PID activity transient prevents a second growing activity history; it does not remove native persistence or add a native-history retention policy.

Execution controls

pid compact <harness> <conversation> \
  [--instructions <text>] [--wait]

pid abort <harness> <conversation>
pid abort <harness> <conversation> --background

Map to Pi Durable's native compaction and abort operations.

Provider authentication

pid auth login <provider>

Use pi-ai's supported OAuth and API-key authentication mechanisms.

Credentials persist locally and are available to managed harnesses. Registry metadata must not contain raw access tokens.

The daemon owns the persistent pi-ai credential store and serializes credential updates and token refresh. The SDK handles authentication interaction with the daemon. Human CLI login uses Inquirer menus and readable browser instructions on stderr. It requires a terminal when a prompt needs input. With "--json", interaction requests use structured stderr and answers come from stdin. Credentials are never printed, and stdout contains only the final result.

Human selection uses arrow keys and Enter. JSON interaction uses the option IDs from the prompt. Secret input and manual callback codes stay hidden, and cancellation restores terminal state. The daemon supplies native provider login options with the app name "PID" and a stable UUID persisted as "auth/.device-id". OpenAI account OAuth requires this installation identity. It is not part of the LMDB registry.

Output and daemon configuration

pid daemon start --state-dir /custom/location

Only daemon startup accepts the state location. Every other command and SDK client connects to the fixed per-user daemon endpoint.

By default, list commands show readable tables, lifecycle commands show short results, watch shows labeled live activity, and errors include corrective guidance. Harness tables show desired and observed state. Conversation lists show model, fork metadata, and pagination instructions. Send remains non-blocking unless "--wait" is set; its result describes submission settlement, while watch displays agent replies.

With "--json", ordinary commands retain one JSON result on stdout: a resource, array, or operation receipt. No success envelope or human text is added. "watch --json" writes JSONL activity only. Errors and diagnostics are JSON objects on stderr, one per line. An error contains at least "error: { code, message }" and exits nonzero. Help returns structured command metadata, and version returns "{ version }". Authentication keeps stdout reserved for its final JSON result and uses structured stderr prompts with stdin answers. Existing scripts must add "--json" to preserve their previous output behavior.

Total: 12 CLI commands.

6. TypeScript SDK

The SDK provides the same operations as the CLI:

- Connect to the user's daemon at its fixed IPC endpoint.
- Discover and manage harnesses.
- Create, list, and fork conversations.
- Submit instructions with delivery semantics.
- Subscribe to normalized harness activity, optionally filtered by conversation.
- Trigger compaction and abort.
- Authenticate supported providers.

Every CLI command delegates to the SDK. The CLI parses arguments, handles terminal interaction, and renders SDK results and errors as human text or optional JSON/JSONL. SDK operations reach the owning daemon through ZeroMQ, and the daemon calls Pi Durable directly.

Agreed SDK surface

The SDK and CLI are independently distributed packages, configured locally as "@elpapi42/pid-sdk" and "@elpapi42/pid-cli". These packages have not been published. The CLI executable remains "pid". "startDaemon(options?)" handles service bootstrap, with optional "stateDir". "connect()" connects to the fixed per-user endpoint and returns a client. The client has no state-directory option.

| SDK method | Arguments and behavior |
| --- | --- |
| "harnesses.start(ref, options?)" | A path, ID, or name, with optional "name" for registration. Declares the harness running and waits for convergence. |
| "harnesses.list()" | Returns desired harness configuration and observed state from the daemon. |
| "harnesses.stop(ref)" | Declares the harness stopped and waits for convergence. |
| "harnesses.destroy(ref)" | Declares the harness absent and waits for cleanup. |
| "conversations.create(ref, options)" | A model for a new conversation, or "fork" with optional "at" and model override. |
| "conversations.list(ref, options?)" | Optional "limit" and "cursor"; returns "items" and optional "next". |
| "send(ref, conversationId, message, options?)" | Optional "requestId", "whenBusy", "whenIdle", and "wait", matching CLI delivery semantics. |
| "watch(ref, options?)" | Optional "conversationId" filter. Resolves after subscription acknowledgment to an "AsyncIterable<Activity>" with "close()". |
| "compact(ref, conversationId, options?)" | Optional "instructions" and "wait". |
| "abort(ref, conversationId, options?)" | Optional "background" includes background tasks in the abort. |
| "auth.login(provider, interaction)" | Interaction callbacks handle authorization URLs and input requests before the final result. |
| "close()" | Closes this SDK client's subscriptions and connection. |

Every client method that accepts a harness reference resolves either its six-character ID or its registered name through the daemon. A script can address an existing harness without creating or starting it. An unknown reference returns an explicit error, and execution against a stopped harness fails without changing desired state.

Closing a watch subscription only unsubscribes that listener. Closing the SDK client disconnects it. Neither action stops harnesses, aborts accepted work, or changes desired state. Ordinary commands return promises, while activities arrive through the acknowledged async-iterable subscription.

Expose stable harness, conversation, entry, submission, and task IDs.

Identifier shapes:

- Harness IDs are exactly six lowercase base36 characters (a-z and 0-9), for example "k7m2qx". PID generates them with Node's cryptographic random-number generator, checks for registry ID/name collisions, and retries before atomic registration. The candidate space has 36^6 = 2,176,782,336 values. The ID is the persisted LMDB key and remains stable across stop/start and restart. Names are optional human-readable aliases. IDs are scoped to this daemon's registry and are not global cross-machine identifiers.
- Conversation IDs retain Pi Durable's native numeric IDs, for example 42. They are scoped to one harness's SQLite storage, stable across restart, and not necessarily consecutive.
- Entry, task, and submission IDs also retain native numeric IDs. Tool call IDs and caller-provided request IDs remain strings.
- A conversation is addressed by the pair of harness reference (six-character ID or name) and native conversation ID. Different harnesses may contain the same conversation number. Forks receive a new native conversation ID in their harness.

7. Concurrency and Reliability

- One active daemon process per OS user, owning one configured state directory.
- One writable Pi Durable instance per harness, owned by that daemon.
- An OS process-lifetime lock prevents competing daemons. LMDB transactions make desired-state updates atomic, and the daemon validates unique names and working directories.
- In-flight operations and callbacks must respect the current harness runtime generation.
- Commands must return explicit failures when delivery cannot be confirmed.
- Use Pi Durable's native submission IDs and request IDs for safe retry/deduplication where available.
- Crashes must not silently duplicate accepted instructions.
- Process recovery must preserve conversation and task state.
- Multiple SDK clients can safely request the same registry and harness through the daemon simultaneously.
- Harnesses share the daemon's process and failure boundary. Separate harness processes are out of scope for MVP.

MVP targets one Unix-like host supporting ZeroMQ IPC. That host can be a local machine or a single cloud VM, with SDK clients running on the same host. Remote client transports and multi-host orchestration are out of scope. Linux with a systemd user service is the initial service-integration target; boot before login requires user lingering. Additional OS service integrations are separate support milestones.

8. External Applications

PID is independent of its consumers.

Possible integrations:

- Linear gateway exposing harnesses as Linear agents.
- Slack or Telegram agent gateways.
- Local artifact-first editor.
- Automated development workflows.
- Custom orchestrators.

One harness can serve multiple gateways simultaneously, using separate or shared conversations.

Gateways communicate exclusively through the SDK. They do not embed Pi Durable or manage its processes.

9. Out of Scope

- HTTP or WebSocket APIs.
- Built-in third-party gateways.
- Web or graphical interfaces.
- Built-in agent configuration framework.
- Automatic skills, system-prompt, or "AGENTS.md" loading.
- Global extensions or agent profiles.
- Custom provider implementations.
- Managed cloud infrastructure, remote client transports, or multi-machine orchestration. Running PID on one cloud VM through local IPC is supported.
- Full exposure of every native Pi Durable API.
- Dedicated transcript-history browsing commands.
- Separate durable activity event journal.
- Multiple daemon instances per OS user, automatic state-directory migration, and infrastructure-style manifests or planning.
- Standalone executables bundling Node.js and native dependencies. The MVP distributes compiled npm packages and requires Node.js.

10. MVP Success Criteria

A user must be able to:

1. Start the daemon and have it recover after reboot.
2. Register a harness from a working directory.
3. Automatically load local Pi Durable extensions.
4. Authenticate a supported provider.
5. Create or fork a conversation.
6. Send instructions with delivery semantics.
7. Observe normalized live harness activity from another CLI or SDK client, optionally filtered by conversation.
8. Compact or abort execution.
9. Recover the harness and unfinished work after crashes.
10. Stop or destroy a harness without automatic resurrection.
11. Read human CLI output by default, or parse results with "--json" and live activity as flat JSONL with "watch --json", without snapshots or activity replay.
12. Address an existing harness by its six-character ID or name from an independent SDK client.

Multiple clients must be able to interact with the same harness without competing runtime ownership.

End goal: Turn Pi Durable into an always-on, local, multi-client agent runtime with a minimal CLI/SDK control plane, reusable by independent applications without embedding or managing the harness themselves.

11. Project Structure and Package Boundaries

Use one npm-workspaces repository with two independently publishable packages:

```text
pid/
├── vision.md
├── package.json                 # Private workspace root
├── package-lock.json
├── tsconfig.base.json
├── packages/
│   ├── sdk/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts          # Public SDK exports
│   │   │   ├── client.ts         # Commands and subscriptions
│   │   │   ├── bootstrap.ts      # startDaemon and service setup
│   │   │   ├── protocol.ts       # Client/daemon wire contract
│   │   │   ├── types.ts          # Public resource/activity types
│   │   │   └── daemon/
│   │   │       ├── main.ts       # Separate process entry point
│   │   │       ├── server.ts     # ZeroMQ request handling
│   │   │       ├── reconciler.ts
│   │   │       ├── store.ts      # LMDB desired state
│   │   │       ├── harness.ts    # Pi Durable integration
│   │   │       ├── activities.ts
│   │   │       └── auth.ts
│   │   └── test/
│   └── cli/
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── main.ts           # pid executable
│       │   ├── commands.ts       # Commander definitions and SDK calls
│       │   ├── output.ts         # Human results, activity, and errors
│       │   └── auth.ts           # Inquirer and structured JSON interaction
│       └── test/
└── test/
    └── integration/             # Installed-package and recovery tests
```

The dependency direction is CLI -> SDK. The CLI declares the SDK as a runtime dependency and uses only its public API. The SDK does not depend on the CLI, and applications can install the SDK alone.

The SDK package includes the daemon as a separate process entry point. This lets "startDaemon()" install and start the service without requiring the CLI. Importing the SDK client does not load or start the daemon. The daemon hosts all active harness instances inside its one process, as specified in section 2.

The protocol remains an internal SDK module shared by the client and daemon. The MVP does not add separate daemon or protocol packages. Installing the SDK therefore also installs its Pi Durable, pi-ai, LMDB, and ZeroMQ runtime dependencies.

Each package has its own package manifest, TypeScript build, tests, generated "dist/" directory, and published artifact. The root is private and holds workspace configuration, one lockfile, shared development configuration, and integration tests. The SDK builds before the CLI. Pin the tested SDK dependency in CLI releases.

12. Distribution and systemd Bootstrap

Compile TypeScript to JavaScript before publication. Publish the SDK's JavaScript and TypeScript declarations, including the compiled private daemon entry point. Publish the CLI as a separate npm package with a "bin" mapping:

```json
{
  "bin": {
    "pid": "./dist/main.js"
  }
}
```

The CLI entry starts with "#!/usr/bin/env node". A global npm installation exposes the "pid" command. Node.js remains a runtime requirement. Installing either package, importing the SDK, or calling "connect()" does not install a service or start the daemon. Service setup occurs only through explicit "startDaemon()" or "pid daemon start".

On Linux, "startDaemon()" performs this sequence through the SDK's bootstrap module:

1. Resolve the configured state directory, the actual Node.js executable, and the installed SDK's compiled daemon entry point. Reject a conflicting state-directory request before changing service configuration. Use absolute executable paths from a persistent installation, independent of the current working directory and interactive shell PATH.
2. Resolve the user unit path as "$XDG_CONFIG_HOME/systemd/user/pid.service", defaulting to "~/.config/systemd/user/pid.service". Create the parent directory if needed.
3. Generate the persistent service definition with the selected state path and correctly escaped unit values. Write a changed definition atomically. The service executes the daemon module directly, rather than invoking "pid daemon start" recursively.
4. Run "systemctl --user daemon-reload" after a unit-file change, then "systemctl --user enable --now pid.service" to enable and start the service.
5. Configure user lingering with "loginctl enable-linger" when needed for boot before login and operation after logout. Permission or service-configuration failures return structured errors instead of claiming boot integration succeeded.
6. Wait for the daemon's ZeroMQ endpoint to report readiness before returning. A started systemd unit alone is not proof that PID is ready to accept commands.

Example unit for the default state directory, with illustrative executable paths replaced by the installer:

```ini
[Unit]
Description=PID daemon

[Service]
Type=exec
ExecStart=/absolute/path/to/node /absolute/path/to/installed-sdk/dist/daemon/main.js --state-dir %h/.pid
Restart=always
RestartSec=3s
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
```

The daemon stays in the foreground while systemd supervises its process. "Restart=always" requests automatic restart after process exit, subject to systemd's service limits. An explicit "systemctl --user stop pid.service" still stops the service. The daemon handles termination by closing its hosted harnesses and storage so native execution state can resume on the next start.

Bootstrap is idempotent. If the matching service already runs with unchanged configuration and boot integration is complete, check readiness and return without rewriting its unit or restarting it. A running process alone does not prove that the service is enabled or user lingering is configured; complete missing setup steps or return their errors. Updating a unit requires "daemon-reload". Applying a changed executable configuration to a running process also requires an explicit "systemctl --user restart pid.service", followed by the readiness check. A conflicting state-directory request follows the existing "state_dir_conflict" rule.

The SDK serializes bootstrap through a separate kernel lock and private bootstrap process entry. A changed unit retains a pending-readiness comment until setup and recovery succeed. A later call retries an interrupted application. Clearing that comment also reloads the unit.

Standalone binary distribution is possible separately, but native dependencies such as LMDB and ZeroMQ require additional platform packaging. It is outside the initial distribution scope.

References: [npm executable packages](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin), [systemd services](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), and [user lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html).

13. Implementation and Validation Sequence

1. Prove the native Pi Durable adapter with a deterministic test provider and a real-provider smoke test. Verify per-conversation models, forks, authentication, committed activity extraction, and recovery. Pin the tested dependency versions because Pi Durable's API is experimental.
2. Build the daemon reconciler and SDK around one complete start/create/send/watch flow. Verify exclusive ownership and acknowledged subscriptions before submitting work.
3. Complete the SDK operations and the human-first Commander/Inquirer CLI with optional JSON/JSONL output, then add OS service installation and boot integration through SDK bootstrap. Build and package the SDK and CLI independently using the agreed workspace layout.
4. Validate human and machine output, terminal prompts and cancellation, command-specific help, two independent clients sharing a harness, six-character ID collision handling, request-ID deduplication after uncertain delivery, daemon crashes, reboot recovery, stopped-harness metadata listing, bounded activity buffers without PID activity persistence, and interrupted stop/destroy cleanup. Confirm that stopped or destroying harnesses do not resume automatically and that user working directories survive destruction.
5. Install the packed SDK without the CLI and verify connection, bootstrap, and runtime operations. Separately install the packed CLI and verify that it operates through its published SDK dependency. Validate unit-file generation, idempotent bootstrap, absolute runtime paths, setup failures, restart configuration, and boot readiness.
