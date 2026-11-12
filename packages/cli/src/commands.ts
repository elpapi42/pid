import { readFileSync } from "node:fs";
import {
  Command,
  CommanderError,
  Help,
  InvalidArgumentError,
  Option,
} from "commander";
import { connect, startDaemon, PidError } from "@elpapi42/pid-sdk";
import type {
  Client,
  ConversationOptions,
  ErrorInfo,
  SendOptions,
} from "@elpapi42/pid-sdk";
import { login } from "./auth.js";
import * as output from "./output.js";

function positive(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError("Expected a positive integer.");
  return Number(value);
}
function pageSize(value: string): number {
  const result = positive(value);
  if (result > 500)
    throw new InvalidArgumentError("Page size must be between 1 and 500.");
  return result;
}
function model(value: string): string {
  if (!/^[^/\s]+\/\S+$/.test(value))
    throw new InvalidArgumentError(
      "Expected provider/model, for example openai/gpt-6-luna.",
    );
  return value;
}
function commandPath(command: Command): string {
  return command.parent
    ? commandPath(command.parent) + " " + command.name()
    : command.name();
}
function leaves(command: Command): Command[] {
  return command.commands
    .filter((child) => child.name() !== "help")
    .flatMap((child) => (child.commands.length ? leaves(child) : [child]));
}
function helpJson(command: Command): object {
  const inherited: Option[] = [];
  for (let current = command.parent; current; current = current.parent)
    inherited.push(...current.options);
  return {
    command: commandPath(command),
    output: "JSON; watch emits JSONL",
    commands: leaves(command).map((child) =>
      `${commandPath(child).slice(commandPath(command).length + 1)} ${child.usage()}`.trim(),
    ),
    description: command.description(),
    usage: `${commandPath(command)} ${command.usage()}`,
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      description: argument.description,
      required: argument.required,
    })),
    options: [
      ...inherited,
      ...command.createHelp().visibleOptions(command),
    ].map((option) => ({
      flags: option.flags,
      description: option.description,
      ...(option.defaultValue === undefined
        ? {}
        : { default: option.defaultValue }),
    })),
  };
}

/** Command parsing, presentation, and terminal interaction stay above the public SDK. */
export async function run(
  argv: string[],
  signal: AbortSignal,
): Promise<number> {
  const program = new Command("pid");
  const version = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version as string;
  let client: Client | undefined;
  const json = () => program.opts<{ json?: boolean }>().json === true;
  const report = async (value: unknown, human: string) =>
    output.line(json() ? JSON.stringify(value) : human);
  const connected = async (): Promise<Client> => {
    if (signal.aborted) throw new PidError("cancelled", "Command canceled");
    client ??= await connect();
    if (signal.aborted) {
      await client.close();
      throw new PidError("cancelled", "Command canceled");
    }
    return client;
  };
  const close = () => {
    void client?.close().catch(() => {});
  };
  program
    .description("Manage persistent local AI harnesses and conversations.")
    .option(
      "--json",
      "Output JSON instead of human-readable text (watch uses JSONL)",
    )
    .option("-v, --version", "Show the installed version")
    .helpCommand(false)
    .exitOverride()
    .showSuggestionAfterError(true)
    .configureOutput({ writeErr() {} })
    .configureHelp({
      showGlobalOptions: true,
      formatHelp(command, helper) {
        return json()
          ? JSON.stringify(helpJson(command)) + "\n"
          : new Help().formatHelp(command, helper);
      },
    })
    .addHelpText("after", () =>
      json()
        ? ""
        : "\nExamples:\n  pid daemon start\n  pid harness start . --name worker\n  pid auth login openai\n  pid harness list --json\n\nRun pid <command> --help for details. Output is human-readable unless --json is set.",
    );
  const examples = (command: Command, text: string) =>
    command.addHelpText("after", () => (json() ? "" : "\nExamples:\n" + text));
  const group = (name: string, description: string) =>
    program
      .command(name)
      .description(description)
      .action((_options, command: Command) => {
        command.outputHelp();
      });
  program.hook("preAction", async () => {
    if (program.opts().version) {
      await report({ version }, version);
      throw new CommanderError(0, "commander.version", "");
    }
  });
  program.action(() => program.outputHelp());
  program
    .command("help")
    .description("Show help for a command")
    .argument("[command...]", "Command path, for example harness start")
    .action((parts: string[]) => {
      let target = program;
      for (const part of parts) {
        const child = target.commands.find((item) => item.name() === part);
        if (!child)
          throw new PidError(
            "unknown_command",
            `Unknown command '${parts.join(" ")}'`,
          );
        target = child;
      }
      target.outputHelp();
    });

  const daemon = group("daemon", "Manage the local daemon service");
  examples(
    daemon
      .command("start")
      .description(
        "Start the daemon, configure its systemd user service, and wait for readiness.",
      )
      .option(
        "--state-dir <path>",
        "State directory, saved in the service configuration (first default: ~/.pid)",
      )
      .action(async (options: { stateDir?: string }) => {
        const info = await startDaemon({ stateDir: options.stateDir });
        await report(
          info,
          `Daemon is ready (PID ${info.pid}).\nState directory: ${output.plain(info.stateDir)}`,
        );
      }),
    "  pid daemon start\n  pid daemon start --state-dir /path/to/state",
  );

  const harness = group("harness", "Start, list, stop, or destroy harnesses");
  examples(
    harness
      .command("start")
      .description(
        "Start a directory or an existing harness. Relative paths use your current directory.",
      )
      .argument("<ref>", "Working directory, six-character harness ID, or name")
      .option("--name <name>", "Unique name for a new harness")
      .action(async (ref: string, options: { name?: string }) => {
        const item = await (await connected()).harnesses.start(ref, options);
        await report(item, output.harnessResult("start", item));
      }),
    "  pid harness start . --name worker\n  pid harness start worker",
  );
  examples(
    harness
      .command("list")
      .description("List desired and observed harness state.")
      .action(async () => {
        const items = await (await connected()).harnesses.list();
        await report(items, output.harnessList(items));
      }),
    "  pid harness list\n  pid harness list --json",
  );
  for (const action of ["stop", "destroy"] as const) {
    examples(
      harness
        .command(action)
        .description(
          action === "stop"
            ? "Stop a harness and preserve its execution data."
            : "Delete a harness's managed execution data. Keep its project directory and shared credentials.",
        )
        .argument("<harness>", "Harness ID or name")
        .action(async (ref: string) => {
          const item = await (await connected()).harnesses[action](ref);
          await report(item, output.harnessResult(action, item));
        }),
      `  pid harness ${action} worker`,
    );
  }

  const conversation = group(
    "conversation",
    "Create, fork, or list conversations",
  );
  examples(
    conversation
      .command("create")
      .description(
        "Create a conversation with a model, or fork an existing conversation and inherit its model.",
      )
      .argument("<harness>", "Harness ID or name")
      .option(
        "--model <provider/model>",
        "Model for a new conversation, or an override for a fork",
        model,
      )
      .option(
        "--fork <conversation>",
        "Conversation to fork (default fork point: latest committed entry)",
        positive,
      )
      .option(
        "--at <entry>",
        "Committed entry to fork at; requires --fork",
        positive,
      )
      .action(
        async (
          ref: string,
          options: { model?: string; fork?: number; at?: number },
        ) => {
          if (options.at !== undefined && options.fork === undefined)
            throw new PidError("invalid_argument", "--at requires --fork");
          if (options.fork === undefined && !options.model)
            throw new PidError(
              "model_required",
              "A new conversation requires --model <provider/model>",
            );
          const creation: ConversationOptions =
            options.fork === undefined
              ? { model: options.model! }
              : { fork: options.fork, at: options.at, model: options.model };
          const item = await (
            await connected()
          ).conversations.create(ref, creation);
          await report(
            item,
            `Conversation ${item.id} created on harness ${output.plain(ref)}.\nModel: ${output.plain(item.model ?? "not configured")}${item.parent ? `\nForked from conversation ${item.parent.conversationId} at entry ${item.parent.at}.` : ""}\nSend a message: pid send ${output.plain(output.shellArgument(ref))} ${item.id} 'Your message'`,
          );
        },
      ),
    "  pid conversation create worker --model openai/gpt-6-luna\n  pid conversation create worker --fork 2\n  pid conversation create worker --fork 2 --at 8",
  );
  examples(
    conversation
      .command("list")
      .description(
        "List conversation metadata, including stopped harnesses. Activity is not replayed.",
      )
      .argument("<harness>", "Harness ID or name")
      .option("--limit <n>", "Page size, from 1 to 500", pageSize, 50)
      .option(
        "--cursor <token>",
        "Opaque next-page cursor from a previous result",
      )
      .action(
        async (ref: string, options: { limit: number; cursor?: string }) => {
          const page = await (
            await connected()
          ).conversations.list(ref, options);
          await report(page, output.conversations(page, ref));
        },
      ),
    "  pid conversation list worker\n  pid conversation list worker --limit 10 --json",
  );

  examples(
    program
      .command("send")
      .description(
        "Submit a message. By default it starts an idle conversation or queues a follow-up while busy.",
      )
      .argument("<harness>", "Harness ID or name")
      .argument(
        "<conversation>",
        "Conversation ID within the harness",
        positive,
      )
      .argument("<message>", "Message text (quote messages containing spaces)")
      .addOption(
        new Option(
          "--when-busy <mode>",
          "Delivery when the conversation is busy",
        )
          .choices(["follow-up", "steer", "reject"])
          .default("follow-up"),
      )
      .addOption(
        new Option(
          "--when-idle <mode>",
          "Delivery when the conversation is idle",
        )
          .choices(["run", "reject"])
          .default("run"),
      )
      .option(
        "--request-id <id>",
        "Stable ID for retrying the same message without duplicate admission",
      )
      .option(
        "--wait",
        "Wait for settlement; use watch to read the agent's activity",
      )
      .action(
        async (
          ref: string,
          id: number,
          message: string,
          options: SendOptions,
        ) => {
          const receipt = await (
            await connected()
          ).send(ref, id, message, options);
          await report(receipt, output.sent(receipt));
        },
      ),
    "  pid send worker 2 'Inspect the project'\n  pid send worker 2 'Continue' --wait\n  pid send worker 2 'Reconsider' --when-busy steer --when-idle reject",
  );
  examples(
    program
      .command("watch")
      .description(
        "Watch new committed activity. There is no token stream or history replay. Ctrl+C closes only this listener.",
      )
      .argument("<harness>", "Harness ID or name")
      .option("--conversation <id>", "Filter one conversation", positive)
      .action(async (ref: string, options: { conversation?: number }) => {
        const api = await connected();
        const subscription = await api.watch(
          ref,
          options.conversation === undefined
            ? {}
            : { conversationId: options.conversation },
        );
        const unsubscribe = () => {
          void subscription.close().catch(() => {});
        };
        signal.addEventListener("abort", unsubscribe, { once: true });
        try {
          if (!json())
            await output.line(
              `Watching harness ${output.plain(ref)}${options.conversation ? `, conversation ${options.conversation}` : ""}. New activity only. Press Ctrl+C to stop watching.`,
              process.stderr,
            );
          for await (const item of subscription)
            await output.line(
              json() ? JSON.stringify(item) : output.activity(item),
            );
        } finally {
          signal.removeEventListener("abort", unsubscribe);
          await subscription.close();
        }
      }),
    "  pid watch worker\n  pid watch worker --conversation 2\n  pid watch worker --json",
  );
  examples(
    program
      .command("compact")
      .description("Compact native conversation context.")
      .argument("<harness>", "Harness ID or name")
      .argument("<conversation>", "Conversation ID", positive)
      .option("--instructions <text>", "Instructions for the summary")
      .option("--wait", "Wait for the compaction task and summary placement")
      .action(
        async (
          ref: string,
          id: number,
          options: { instructions?: string; wait?: boolean },
        ) => {
          const receipt = await (await connected()).compact(ref, id, options);
          await report(receipt, output.compacted(receipt));
        },
      ),
    "  pid compact worker 2 --wait\n  pid compact worker 2 --instructions 'Keep the key decisions' --wait",
  );
  examples(
    program
      .command("abort")
      .description(
        "Abort conversation work and wait for the native abort to complete.",
      )
      .argument("<harness>", "Harness ID or name")
      .argument("<conversation>", "Conversation ID", positive)
      .option("--background", "Include background tasks")
      .action(
        async (ref: string, id: number, options: { background?: boolean }) => {
          const receipt = await (await connected()).abort(ref, id, options);
          await report(
            receipt,
            `Aborted conversation ${id} on harness ${output.plain(ref)}${options.background ? ", including background tasks" : ""}.`,
          );
        },
      ),
    "  pid abort worker 2\n  pid abort worker 2 --background",
  );
  const auth = group("auth", "Authenticate a model provider");
  examples(
    auth
      .command("login")
      .description(
        "Sign in to a provider. Human mode uses terminal prompts; JSON mode uses structured stderr and stdin answers.",
      )
      .argument("<provider>", "Provider ID, for example openai or openrouter")
      .action(async (provider: string) => {
        const receipt = await login(
          await connected(),
          provider,
          json(),
          signal,
        );
        await report(
          receipt,
          `Signed in to ${output.plain(receipt.provider)} using ${receipt.type === "oauth" ? "OAuth" : "an API key"}. Credentials are saved in the daemon's private auth directory.`,
        );
      }),
    "  pid auth login openai\n  pid auth login openrouter\n  pid auth login openai --json",
  );

  signal.addEventListener("abort", close, { once: true });
  try {
    await program.parseAsync(argv, { from: "user" });
    return signal.aborted ? 130 : 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const detail: ErrorInfo = signal.aborted
      ? { code: "cancelled", message: "Command canceled" }
      : error instanceof PidError
        ? error.toJSON()
        : error instanceof CommanderError
          ? {
              code:
                error.code === "commander.unknownCommand"
                  ? "unknown_command"
                  : "invalid_argument",
              message: error.message.replace(/^error: /i, ""),
            }
          : {
              code: "operation_failed",
              message:
                error instanceof Error ? error.message : "Operation failed",
            };
    await output.line(
      json() ? JSON.stringify({ error: detail }) : output.failure(detail),
      process.stderr,
    );
    return signal.aborted || detail.code === "auth_cancelled" ? 130 : 1;
  } finally {
    signal.removeEventListener("abort", close);
    await client?.close();
  }
}
