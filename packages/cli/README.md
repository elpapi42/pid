# @elpapi42/pid-cli

`pid` is a human-first CLI built on the public `@elpapi42/pid-sdk` API. Commander supplies command parsing and help. Inquirer supplies interactive terminal prompts. Requires Linux, Node.js 22.19 or later, systemd user services, and util-linux `/usr/bin/flock`.

The package has not been published. From this repository, build with `npm run build` and run `node packages/cli/dist/main.js`. A global installation of the packed CLI exposes `pid`. Installation alone does not start a daemon.

## Start here

```sh
pid --help
pid daemon start
pid auth login openai
pid harness start . --name worker
pid conversation create worker --model openai/gpt-6-luna
```

Choose OAuth with the arrow keys and Enter to sign in through the browser, or choose API key to enter a key. Open the displayed authorization URL. Secrets and manual callback codes stay hidden. Select an available model for your provider and account.

Use the numeric conversation ID returned by creation. Watch new activity in one terminal, then send a message from another:

```sh
pid watch worker --conversation 2
pid send worker 2 'Inspect this project' --wait
```

Send is non-blocking by default. `--wait` reports native submission settlement. Watch shows agent replies, thinking, tool calls, results, and image descriptions. It does not stream tokens or replay history. Ctrl+C closes only the watch listener and leaves accepted work running.

## Commands and help

```text
pid daemon start [--state-dir <path>]
pid harness start <path|id|name> [--name <name>]
pid harness list
pid harness stop <harness>
pid harness destroy <harness>
pid conversation create <harness> --model <provider/model>
pid conversation create <harness> --fork <conversation> [--at <entry>] [--model <provider/model>]
pid conversation list <harness> [--limit <n>] [--cursor <token>]
pid send <harness> <conversation> <message> [--when-busy <follow-up|steer|reject>] [--when-idle <run|reject>] [--request-id <id>] [--wait]
pid watch <harness> [--conversation <id>]
pid compact <harness> <conversation> [--instructions <text>] [--wait]
pid abort <harness> <conversation> [--background]
pid auth login <provider>
```

The two creation forms are one command, for 12 operations. Every command accepts `--json`. Get command-specific arguments, options, and examples with `pid harness start --help` or `pid help harness start`. `pid --version` shows the installed version. Help and version also support `--json`.

`daemon start` writes or updates the managed systemd user unit, enables startup and lingering, starts the service, and checks ZeroMQ readiness. Only this command accepts `--state-dir`. The default is `~/.pid`, and the unit saves the location. A different location conflicts with a running daemon.

Harness references use a six-character ID or unique name. Start also accepts a directory relative to the caller. Start is idempotent. Stop preserves data. Destroy deletes managed execution data and preserves the project and shared credentials. Harness tables show desired and observed state, plus recovery errors when present.

Models belong to conversations. Forks inherit their model unless overridden. Conversation, entry, task, and submission IDs are positive integers scoped to the harness. `--at` requires `--fork`. Conversation tables show model and fork metadata, with a next-page command when more results exist.

Send defaults to `--when-busy follow-up` and `--when-idle run`. Steering enters the current run at a native boundary. Rejection flags refuse messages that do not meet the requested busy or idle condition. Retry uncertain delivery with the same message and `--request-id`.

## Machine output

Human output is the default, even when redirected. Existing scripts must add `--json`. The flag can appear before or after the command:

```sh
pid harness list --json
pid --json conversation list worker
pid watch worker --json
pid --help --json
pid --version --json
```

Ordinary commands write one JSON value to stdout. Watch writes the original flat activity objects as JSONL. No colors, spinners, or terminal widgets are added. Human watch removes terminal control sequences and describes images. JSON retains the complete original data, including image base64.

Errors use stderr and a nonzero exit code. With `--json`, their existing shape is preserved:

```json
{"error":{"code":"harness_stopped","message":"Harness is not declared running"}}
```

`pid auth login openai --json` uses structured prompts and instructions on stderr, with newline-separated answers from stdin. Select prompts accept their option ID, such as `oauth` or `api_key`. Stdout contains only the final result. Machine-mode terminal input has no visible widgets and does not echo secrets. Human prompts require a terminal when input is needed. Cancellation restores terminal state and exits with code 130.

Closing the CLI does not stop harnesses or accepted work. Use `systemctl --user stop pid.service` or `systemctl --user restart pid.service` to manage the daemon. Read its logs with `journalctl --user -u pid.service`.
