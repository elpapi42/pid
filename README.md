# PID

PID hosts persistent Pi Durable harnesses in one local daemon. Independent clients use the TypeScript SDK through ZeroMQ IPC. The `pid` CLI uses the same public SDK.

Each harness has a six-character ID, a working directory, native SQLite storage, and multiple conversations. LMDB stores only desired harness configuration. The daemon restores running harnesses after a restart and leaves stopped harnesses stopped.

## Requirements

- Linux with a systemd user manager and `loginctl`.
- Node.js 22.19 or later and npm. Node remains required after installation.
- util-linux `/usr/bin/flock` for exclusive daemon ownership and serialized service setup.
- Native LMDB and ZeroMQ support for the target platform. The package checks use Linux x64 prebuilt dependencies.

`pid daemon start` writes a persistent user unit and enables user lingering when needed. The host must permit lingering for boot before login. Installation, SDK imports, and `connect()` do not start a service.

## Develop

```sh
npm ci
npm run build
node packages/cli/dist/main.js --help
npm test
npm run test:packages
```

`npm test` includes real native storage, ZeroMQ, and terminal tests. The terminal test uses Python 3's standard library to create a PTY. The systemd test creates and removes a uniquely named transient user service. It does not replace `pid.service`. The package test needs network access to install dependencies into temporary, independent projects.

The workspace has two independently packed npm packages:

| Directory | Package | Purpose |
| --- | --- | --- |
| `packages/sdk` | `@elpapi42/pid-sdk` | Public SDK and private daemon entry |
| `packages/cli` | `@elpapi42/pid-cli` | Human-first CLI with optional JSON output, built on the SDK |

These package names are configured locally. No package has been published. Run `npm pack -w @elpapi42/pid-sdk` and `npm pack -w @elpapi42/pid-cli` to create release artifacts. Install the artifacts from a persistent directory before configuring a long-lived service. The unit records absolute Node and SDK paths.

## Use

After installing the CLI:

```sh
pid daemon start
pid auth login openrouter
pid harness start /absolute/path/to/project --name worker
pid conversation create worker --model openrouter/openai/gpt-4.1-nano
```

Use the returned numeric conversation ID in subsequent commands. Start a watch in one terminal, then send a message from another:

```sh
pid watch worker --conversation 1
pid send worker 1 'Inspect this project' --wait
```

The CLI uses Commander for commands and help, and Inquirer for terminal prompts. Commands show readable tables and messages by default. Use `pid <command> --help` or `pid help <command>` for examples. Human output remains the default when redirected.

Every command accepts `--json`, before or after the command. This selects the existing machine contract: one JSON result on stdout, JSON errors on stderr, and JSONL for `watch --json`. Help and version also support `--json`. Existing scripts must add the flag. Machine mode has no colors or interactive widgets. Human activity output removes terminal control sequences from agent text and describes images without printing base64. JSON preserves the original activity data.

For OpenAI account login, run `pid auth login openai`, use the arrow keys to choose OAuth, and open the displayed authorization URL. Secrets and manual callback codes stay hidden. Interactive prompts require a terminal. For automation, `auth login --json` writes structured prompts and instructions to stderr and accepts newline-separated answers through stdin. The daemon keeps one stable installation UUID in `auth/.device-id` for provider flows that require a host identity.

See the [CLI reference](packages/cli/README.md), [SDK API and examples](packages/sdk/README.md), and [full specification](vision.md).

## Extensions and activity

PID loads sorted `.js`, `.mjs`, `.ts`, and `.mts` files directly inside `<cwd>/.pid/extensions/`. Each file must default-export a native Durable extension or an array of extensions. TypeScript must use Node-supported erasable syntax. Native `@earendil-works/*` imports resolve from the installed SDK, so a project does not need its own npm installation for those imports. Other dependencies follow normal Node resolution.

```js
// .pid/extensions/hello.mjs
export default {
  name: "hello",
  tools: [{
    name: "hello",
    description: "Return a greeting",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ output: [{ type: "text", text: "Hello" }] }),
  }],
};
```

There are no built-in agent tools, system prompts, skills, or `AGENTS.md` loading. Supply these through extensions. Extensions share the daemon process. A blocking or fatal extension can affect every harness. Restart the daemon after editing extension code because Node caches imported modules.

The live feed emits complete committed `thinking`, `assistant_message`, `user_message`, `image`, `tool_call`, `tool_result`, and `error` objects. PID keeps bounded memory buffers and never stores its activity feed. A disconnected or slow subscription ends explicitly. There is no token feed, replay, or automatic reconnection across a gap. Native Durable transcript and task storage still grows with use.

## Storage and service operations

The default state directory is `~/.pid`. Only `startDaemon({ stateDir })` or `pid daemon start --state-dir PATH` selects another location. The saved unit preserves that location. Clients find one fixed endpoint at `$XDG_RUNTIME_DIR/pid/daemon.sock`, with a private per-user temporary directory fallback.

LMDB has root `schemaVersion: 1` and one named `harnesses` database. Each key maps to `{ cwd, name?, desired }`, where desired is `running`, `stopped`, or `absent`. Observed state and errors stay in memory. Native storage lives at `harnesses/<id>/session.sqlite`. Credentials live in private files under `auth/`.

`harness stop` preserves data. `harness destroy` deletes only PID-managed execution data and removes the registry record after cleanup succeeds. It preserves the project directory and shared credentials. Failed cleanup retains absent intent for retry.

```sh
systemctl --user status pid.service
journalctl --user -u pid.service
systemctl --user restart pid.service
systemctl --user stop pid.service
```

An explicit service stop overrides automatic restart. To remove boot integration, run `systemctl --user disable --now pid.service`, remove the managed unit from `$XDG_CONFIG_HOME/systemd/user/pid.service` or `~/.config/systemd/user/pid.service`, and run `systemctl --user daemon-reload`. This does not delete state. PID does not disable user lingering because other user services can require it.

Stopped conversation listing uses `Harness.open({ readOnly: true })` and does not resume native tasks. Pi Durable 1.5.2 still writes SQLite migration bookkeeping when opening storage. That operation therefore needs filesystem write access to the database.

The test suite checks real systemd crash restart and durable submission recovery. A physical host reboot has not been tested. The persistent unit and lingering setup cover the boot configuration path.
