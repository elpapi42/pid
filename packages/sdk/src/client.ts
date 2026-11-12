import { randomUUID } from "node:crypto";
import { Dealer } from "zeromq";
import { endpoint, validateEndpoint } from "./paths.js";
import {
  decode,
  encode,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_ITEMS,
  PidError,
  VERSION,
} from "./protocol.js";
import type { Command, Frame } from "./protocol.js";
import type {
  Activity,
  ActivitySubscription,
  AuthInteraction,
  AuthPrompt,
  Client,
  DaemonInfo,
  ErrorInfo,
} from "./types.js";
class Subscription implements ActivitySubscription {
  private queue: {
    activity: Activity;
    bytes: number;
  }[] = [];
  private bytes = 0;
  private waiter?: {
    resolve: (value: IteratorResult<Activity>) => void;
    reject: (error: unknown) => void;
  };
  private ended = false;
  private failure?: Error;
  private consumed = false;
  constructor(private readonly unsubscribe: () => Promise<void>) {}
  push(activity: Activity): void {
    if (this.ended) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: activity, done: false });
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(activity));
    if (
      this.queue.length >= MAX_QUEUE_ITEMS ||
      this.bytes + bytes > MAX_QUEUE_BYTES
    ) {
      this.end(
        new PidError(
          "activity_overflow",
          "Activity consumer is too slow; subscribe again",
        ),
      );
      void this.unsubscribe().catch(() => {});
      return;
    }
    this.queue.push({ activity, bytes });
    this.bytes += bytes;
  }
  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    this.queue = [];
    this.bytes = 0;
    if (this.waiter) {
      if (error) this.waiter.reject(error);
      else this.waiter.resolve({ done: true, value: undefined });
      this.waiter = undefined;
    }
  }
  async close(): Promise<void> {
    if (this.ended) return;
    this.end();
    await this.unsubscribe();
  }
  [Symbol.asyncIterator](): AsyncIterator<Activity> {
    if (this.consumed)
      throw new PidError(
        "subscription_in_use",
        "A subscription supports one iterator",
      );
    this.consumed = true;
    return {
      next: async () => {
        if (this.failure) throw this.failure;
        const next = this.queue.shift();
        if (next) {
          this.bytes -= next.bytes;
          return { value: next.activity, done: false };
        }
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<Activity>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: async () => {
        await this.close();
        return { done: true, value: undefined };
      },
    };
  }
}
type Pending = {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
  command: Command;
  args: Record<string, unknown>;
};
export class Connection implements Client {
  private readonly socket = new Dealer({
    routingId: randomUUID(),
    immediate: true,
    linger: 0,
    sendTimeout: 1000,
    heartbeatInterval: 1000,
    heartbeatTimeout: 5000,
  });
  private readonly pending = new Map<string, Pending>();
  private readonly streams = new Map<string, Subscription>();
  private readonly interactions = new Map<string, AuthInteraction>();
  private readonly prompts = new Map<string, AbortController>();
  private instance?: string;
  private session?: string;
  private closed = false;
  private heartbeat?: NodeJS.Timeout;
  private pinging = false;
  private sendTail: Promise<void> = Promise.resolve();
  constructor(private readonly timeoutMs = 30000) {}
  async open(): Promise<DaemonInfo> {
    await validateEndpoint();
    this.socket.connect(endpoint());
    void this.receive();
    void this.monitor();
    const info = await this.rpc<
      DaemonInfo & {
        clientSessionId: string;
      }
    >("health", {}, Math.min(this.timeoutMs, 3000));
    this.instance = info.instanceId;
    this.session = info.clientSessionId;
    this.heartbeat = setInterval(() => {
      if (this.pinging || this.closed) return;
      this.pinging = true;
      void this.rpc<
        DaemonInfo & {
          clientSessionId: string;
        }
      >("health", {}, 4000)
        .then((info) => {
          if (info.clientSessionId !== this.session)
            throw new PidError(
              "connection_lost",
              "Daemon ended this client session; reconnect and subscribe again",
            );
        })
        .catch((error) => this.fail(error))
        .finally(() => {
          this.pinging = false;
        });
    }, 2000);
    this.heartbeat.unref();
    return info;
  }
  async rpc<T>(
    command: Command,
    args: Record<string, unknown>,
    timeout = this.timeoutMs,
    id = randomUUID(),
  ): Promise<T> {
    if (this.closed)
      throw new PidError("client_closed", "The SDK client is closed");
    if (this.pending.size >= 128)
      throw new PidError("request_limit", "Too many outstanding requests");
    const body = encode({
      v: VERSION,
      id,
      instance: this.instance,
      command,
      args,
    });
    const promise = new Promise<T>((resolve, reject) => {
      const item: Pending = { resolve, reject, command, args };
      if (timeout > 0)
        item.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(this.uncertain(item, "Request timed out"));
        }, timeout);
      this.pending.set(id, item);
    });
    this.sendTail = this.sendTail
      .catch(() => {})
      .then(async () => {
        if (!this.pending.has(id)) return;
        try {
          await this.socket.send(body);
        } catch {
          const item = this.pending.get(id);
          if (item) {
            this.pending.delete(id);
            clearTimeout(item.timer);
            item.reject(
              this.uncertain(item, "Daemon delivery could not be confirmed"),
            );
          }
        }
      });
    return promise;
  }
  private uncertain(item: Pending, message: string): PidError {
    if (
      [
        "health",
        "harness.list",
        "conversation.list",
        "watch",
        "unwatch",
      ].includes(item.command)
    )
      return new PidError("daemon_unavailable", message);
    return new PidError(
      "delivery_uncertain",
      message,
      item.command === "send" ? { requestId: item.args.requestId } : undefined,
    );
  }
  private async receive(): Promise<void> {
    try {
      for await (const [buffer] of this.socket) {
        if (!buffer) continue;
        const value = decode(buffer);
        if (
          value.v !== VERSION ||
          typeof value.instance !== "string" ||
          typeof value.type !== "string"
        )
          throw new PidError("protocol_mismatch", "Invalid PID response");
        if (this.instance && value.instance !== this.instance)
          throw new PidError(
            "daemon_restarted",
            "Daemon changed; reconnect and subscribe again",
          );
        const frame = value as unknown as Frame;
        if (frame.type === "response") {
          const item = this.pending.get(frame.id);
          if (!item) continue;
          this.pending.delete(frame.id);
          clearTimeout(item.timer);
          if (frame.error)
            item.reject(
              new PidError(
                frame.error.code,
                frame.error.message,
                frame.error.details,
              ),
            );
          else item.resolve(frame.result);
        } else if (frame.type === "activity")
          this.streams.get(frame.subscriptionId)?.push(frame.activity);
        else if (frame.type === "subscription.end") {
          const stream = this.streams.get(frame.subscriptionId);
          this.streams.delete(frame.subscriptionId);
          stream?.end(
            frame.error
              ? new PidError(frame.error.code, frame.error.message)
              : undefined,
          );
        } else if (frame.type === "auth.event")
          this.interactions.get(frame.id)?.notify(frame.event);
        else if (frame.type === "auth.prompt.cancel") {
          this.prompts.get(frame.promptId)?.abort();
          this.prompts.delete(frame.promptId);
        } else if (frame.type === "auth.prompt") {
          const interaction = this.interactions.get(frame.id);
          if (!interaction) continue;
          const controller = new AbortController();
          this.prompts.set(frame.promptId, controller);
          void Promise.resolve()
            .then(() =>
              interaction.prompt({
                ...(frame.prompt as AuthPrompt),
                signal: controller.signal,
              }),
            )
            .then(
              (answer) =>
                this.rpc("auth.answer", { promptId: frame.promptId, answer }),
              () =>
                controller.signal.aborted
                  ? undefined
                  : this.rpc("auth.cancel", { loginId: frame.id }),
            )
            .catch(() => {})
            .finally(() => this.prompts.delete(frame.promptId));
        }
      }
      if (!this.closed)
        this.fail(
          new PidError(
            "connection_lost",
            "Daemon connection ended; reconnect and subscribe again",
          ),
        );
    } catch (error) {
      if (!this.closed) this.fail(error);
    }
  }
  private async monitor(): Promise<void> {
    try {
      for await (const event of this.socket.events) {
        if (event.type === "disconnect" && !this.closed) {
          this.fail(
            new PidError(
              "connection_lost",
              "Daemon disconnected; reconnect and subscribe again",
            ),
          );
          break;
        }
      }
    } catch {
      /* Socket close also closes its observer. */
    }
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    const failure =
      error instanceof Error
        ? error
        : new PidError("connection_lost", "Daemon connection lost");
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        item.command === "send"
          ? this.uncertain(
              item,
              "Connection lost after submission may have been accepted",
            )
          : failure,
      );
    }
    this.pending.clear();
    for (const stream of this.streams.values()) stream.end(failure);
    this.streams.clear();
    for (const prompt of this.prompts.values()) prompt.abort();
    this.prompts.clear();
    this.socket.close();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.rpc("unwatch", { all: true }, 1000).catch(() => {});
    for (const stream of this.streams.values()) stream.end();
    this.streams.clear();
    this.fail(new PidError("client_closed", "The SDK client is closed"));
  }
  readonly harnesses: Client["harnesses"] = {
    start: (ref, options = {}) =>
      this.rpc("harness.start", { ref, ...options, baseDir: process.cwd() }),
    list: () => this.rpc("harness.list", {}),
    stop: (ref) => this.rpc("harness.stop", { ref }),
    destroy: (ref) => this.rpc("harness.destroy", { ref }),
  };
  readonly conversations: Client["conversations"] = {
    create: (ref, options) =>
      this.rpc("conversation.create", { ref, ...options }),
    list: (ref, options = {}) =>
      this.rpc("conversation.list", { ref, ...options }),
  };
  readonly send: Client["send"] = (
    ref,
    conversationId,
    message,
    options = {},
  ) =>
    this.rpc(
      "send",
      {
        ref,
        conversationId,
        message,
        ...options,
        requestId: options.requestId ?? randomUUID(),
      },
      options.wait ? 0 : undefined,
    );
  readonly compact: Client["compact"] = (ref, conversationId, options = {}) =>
    this.rpc(
      "compact",
      { ref, conversationId, ...options },
      options.wait ? 0 : undefined,
    );
  readonly abort: Client["abort"] = (ref, conversationId, options = {}) =>
    this.rpc("abort", { ref, conversationId, ...options }, 0);
  readonly watch: Client["watch"] = async (ref, options = {}) => {
    const subscriptionId = randomUUID();
    const subscription = new Subscription(async () => {
      this.streams.delete(subscriptionId);
      if (!this.closed) await this.rpc("unwatch", { subscriptionId });
    });
    this.streams.set(subscriptionId, subscription);
    try {
      await this.rpc("watch", { ref, ...options, subscriptionId });
      return subscription;
    } catch (error) {
      this.streams.delete(subscriptionId);
      subscription.end();
      throw error;
    }
  };
  readonly auth: Client["auth"] = {
    login: async (provider, interaction) => {
      if (interaction.signal?.aborted)
        throw new PidError("auth_cancelled", "Authentication cancelled");
      const id = randomUUID();
      this.interactions.set(id, interaction);
      const cancel = () => {
        void this.rpc("auth.cancel", { loginId: id }).catch(() => {});
      };
      interaction.signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await this.rpc("auth.login", { provider }, 0, id);
      } finally {
        this.interactions.delete(id);
        interaction.signal?.removeEventListener("abort", cancel);
      }
    },
  };
}
export async function connect(
  options: {
    timeoutMs?: number;
  } = {},
): Promise<Client> {
  const client = new Connection(options.timeoutMs);
  try {
    await client.open();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
