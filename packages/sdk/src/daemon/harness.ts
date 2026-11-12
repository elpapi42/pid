import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { AgentDoc, Harness, createRegistry } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryId,
  Extension,
  HarnessOptions,
  Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
  ConversationOptions,
  ConversationPage,
  ConversationSummary,
  HarnessSpec,
  SendOptions,
} from "../types.js";
import { idField, PidError, textField } from "../protocol.js";
import { Activities } from "./activities.js";
export function modelRef(value: string): {
  provider: string;
  modelId: string;
} {
  textField(value, "model", 1024);
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1)
    throw new PidError(
      "invalid_model",
      "Model must have provider/model format",
    );
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}
function cursorDecode(token?: string): Cursor | undefined {
  if (token === undefined) return;
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 8192)
    throw new PidError("invalid_cursor", "Invalid conversation cursor");
  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new PidError("invalid_cursor", "Invalid conversation cursor");
  }
}
export class Runtime {
  private environments = new Map<string, NodeExecutionEnv>();
  private observation?: {
    detach(): void;
  };
  private hooks?: ReturnType<typeof registerHooks>;
  private constructor(
    readonly native: Harness,
    readonly storage: Storage,
    private readonly activities?: Activities,
  ) {}
  static async open(
    file: string,
    spec: HarnessSpec,
    models: HarnessOptions["models"],
    options: {
      readOnly?: boolean;
      activities?: Activities;
      failed?: (error: unknown) => void;
    } = {},
  ): Promise<Runtime> {
    const registry = createRegistry();
    let hooks: ReturnType<typeof registerHooks> | undefined;
    if (!options.readOnly) {
      const project = pathToFileURL(
        spec.cwd.endsWith("/") ? spec.cwd : spec.cwd + "/",
      ).href;
      hooks = registerHooks({
        resolve(specifier, parent, next) {
          if (
            specifier.startsWith("@earendil-works/") &&
            parent.parentURL?.startsWith(project)
          ) {
            // Extensions share the installed runtime's native package versions, including in npm-free projects.
            try {
              return next(specifier, { ...parent, parentURL: import.meta.url });
            } catch (error) {
              if (
                (error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND"
              )
                throw error;
            }
          }
          return next(specifier, parent);
        },
      });
      try {
        const directory = join(spec.cwd, ".pid", "extensions");
        let files: string[];
        try {
          files = (await readdir(directory))
            .filter(
              (file) =>
                /\.(?:m?js|m?ts)$/.test(file) && !file.endsWith(".d.ts"),
            )
            .sort();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") files = [];
          else throw error;
        }
        for (const file of files) {
          const module = await import(
            pathToFileURL(join(directory, file)).href
          );
          const exports: unknown[] = Array.isArray(module.default)
            ? module.default
            : [module.default];
          if (
            exports.some(
              (extension) =>
                !extension ||
                typeof extension !== "object" ||
                typeof (extension as Extension).name !== "string",
            )
          )
            throw new PidError(
              "invalid_extension",
              `Extension ${file} must default-export a Durable extension or array of extensions`,
            );
          for (const extension of exports)
            registry.install(extension as Extension);
        }
      } catch (error) {
        hooks.deregister();
        throw error;
      }
    }
    // Durable 1.5.2's storage initializer writes migration bookkeeping even at the current schema.
    // Its supported read-only view is Harness.readOnly over a normally opened SQLite connection.
    let storage: Storage;
    try {
      storage = await openNodeSqliteStorage(file);
    } catch (error) {
      hooks?.deregister();
      throw error;
    }
    let runtime: Runtime | undefined;
    const envs = new Map<string, NodeExecutionEnv>();
    try {
      const native = await Harness.open(
        storage,
        {
          models,
          registry,
          readOnly: options.readOnly,
          env: (target) => {
            const cwd = target.cwd ?? spec.cwd;
            let env = envs.get(cwd);
            if (!env) {
              env = new NodeExecutionEnv({ cwd });
              envs.set(cwd, env);
            }
            return env;
          },
          onReport: (report) => {
            if (report.kind === "storage_failed")
              options.failed?.(report.error);
          },
        },
        context,
      );
      runtime = new Runtime(native, storage, options.activities);
      runtime.hooks = hooks;
      // Keep ownership of environments created after open, too.
      runtime.environments = envs;
      if (options.activities)
        runtime.observation = native.observeCommits({
          advance: (publication) => options.activities!.advance(publication),
          end: () => {},
        });
      return runtime;
    } catch (error) {
      hooks?.deregister();
      await storage.close(context).catch(() => {});
      await Promise.allSettled(
        [...envs.values()].map((env) => env.cleanup(context)),
      );
      throw error;
    }
  }
  resume(): void {
    this.native.resume();
  }
  async summary(id: ConversationId): Promise<ConversationSummary> {
    const record = await this.native.commit(
      (tx) => tx.conversation(id),
      context,
    );
    if (!record)
      throw new PidError(
        "conversation_not_found",
        "Conversation does not exist in this harness",
      );
    const agent = await this.native.snapshot(AgentDoc, id, context);
    return {
      id,
      ...(agent?.model
        ? { model: `${agent.model.provider}/${agent.model.modelId}` }
        : {}),
      ...(record.parent
        ? {
            parent: {
              conversationId: record.parent.conversationId,
              at: record.parent.at,
            },
          }
        : {}),
    };
  }
  async conversation(id: number): Promise<Conversation> {
    const conversation = await this.native.conversation(
      idField(id) as ConversationId,
      context,
    );
    if (!conversation)
      throw new PidError(
        "conversation_not_found",
        "Conversation does not exist in this harness",
      );
    return conversation;
  }
  async create(
    spec: HarnessSpec,
    options: ConversationOptions,
  ): Promise<ConversationSummary> {
    const agent = {
      cwd: spec.cwd,
      ...(options.model ? { model: modelRef(options.model) } : {}),
    };
    let created: Conversation;
    if (options.fork !== undefined) {
      const parent = await this.conversation(options.fork);
      const at =
        options.at ??
        (await this.native.commit(
          (tx) => tx.latestEntryId(parent.id),
          context,
        ));
      if (at === undefined)
        throw new PidError(
          "empty_conversation",
          "Cannot fork an empty conversation",
        );
      created = await parent.fork(
        at as EntryId,
        {
          ownership: { kind: "ownerless" },
          ...(options.model
            ? { agent: { model: modelRef(options.model) } }
            : {}),
        },
        context,
      );
    } else {
      if (!options.model)
        throw new PidError(
          "model_required",
          "New conversations require a model",
        );
      created = await this.native.createConversation(
        { ownership: { kind: "ownerless" }, agent },
        context,
      );
    }
    return this.summary(created.id);
  }
  async list(limit = 50, token?: string): Promise<ConversationPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new PidError(
        "invalid_limit",
        "Conversation page size must be between 1 and 500",
      );
    const page = await this.native.commit(
      (tx) =>
        tx.scanConversations(
          { order: "descending" },
          limit,
          cursorDecode(token),
        ),
      context,
    );
    const items = await Promise.all(
      page.items.map((item) => this.summary(item.id)),
    );
    return {
      items,
      ...(page.next
        ? { next: Buffer.from(JSON.stringify(page.next)).toString("base64url") }
        : {}),
    };
  }
  async send(
    id: number,
    message: string,
    options: SendOptions & {
      requestId: string;
    },
    signal?: AbortSignal,
  ): Promise<import("../types.js").SendReceipt> {
    const conversation = await this.conversation(id);
    const submission = await conversation.submit(
      {
        type: "input",
        content: message,
        requestId: options.requestId,
        whenBusy:
          options.whenBusy === "follow-up" ? "followUp" : options.whenBusy,
        whenIdle: options.whenIdle === "reject" ? "reject" : undefined,
      },
      context,
    );
    return {
      submissionId: submission.id,
      requestId: options.requestId,
      ...(options.wait
        ? {
            settlement: await submission.wait(
              signal ? withAbortSignal(signal, context) : context,
            ),
          }
        : {}),
    };
  }
  async compact(
    id: number,
    instructions?: string,
    wait?: boolean,
    signal?: AbortSignal,
  ): Promise<import("../types.js").CompactReceipt> {
    const taskId = await (
      await this.conversation(id)
    ).compact(instructions, context);
    if (!wait) return { taskId };
    const waitContext = signal ? withAbortSignal(signal, context) : context;
    const settled = await this.native.waitForTask(taskId, waitContext);
    const outcome = settled.state.outcome;
    const submission =
      outcome.status === "completed" &&
      outcome.result.submissionId !== undefined
        ? await this.native.submission(outcome.result.submissionId, context)
        : undefined;
    return {
      taskId,
      outcome,
      ...(submission ? { settlement: await submission.wait(waitContext) } : {}),
    };
  }
  async abort(
    id: number,
    background = false,
  ): Promise<{
    aborted: true;
  }> {
    await (await this.conversation(id)).abort(context, { background });
    return { aborted: true };
  }
  async close(): Promise<void> {
    try {
      await this.native.close(context);
    } finally {
      this.observation?.detach();
      this.activities?.close();
      this.hooks?.deregister();
      await Promise.all(
        [...this.environments.values()].map((env) => env.cleanup(context)),
      );
      this.environments.clear();
    }
  }
}
