import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Router } from "zeromq";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models } from "@earendil-works/pi-ai";
import {
  encode,
  errorInfo,
  idField,
  MAX_QUEUE_BYTES,
  MAX_QUEUE_ITEMS,
  optionalBoolean,
  parseRequest,
  PidError,
  textField,
  VERSION,
} from "../protocol.js";
import type { Frame, Request } from "../protocol.js";
import { endpoint, prepareRuntimeDirectory } from "../paths.js";
import type { Activity, ConversationOptions, ErrorInfo } from "../types.js";
import { Credentials } from "./auth.js";
import { Reconciler } from "./reconciler.js";
import { Store } from "./store.js";
type Peer = {
  key: string;
  route: Buffer;
  session: string;
  lastSeen: number;
  abort: AbortController;
  pending: Set<string>;
  subscriptions: Map<
    string,
    {
      harness: string;
      conversationId?: number;
    }
  >;
};
type Prompt = {
  peer: Peer;
  login: string;
  resolve: (answer: string) => void;
  reject: (error: unknown) => void;
};
type Outbound<F = Frame> = F extends Frame ? Omit<F, "v" | "instance"> : never;
const allowed: Record<Request["command"], readonly string[]> = {
  health: [],
  "harness.start": ["ref", "name", "baseDir"],
  "harness.list": [],
  "harness.stop": ["ref"],
  "harness.destroy": ["ref"],
  "conversation.create": ["ref", "model", "fork", "at"],
  "conversation.list": ["ref", "limit", "cursor"],
  send: [
    "ref",
    "conversationId",
    "message",
    "requestId",
    "whenBusy",
    "whenIdle",
    "wait",
  ],
  watch: ["ref", "conversationId", "subscriptionId"],
  unwatch: ["subscriptionId", "all"],
  compact: ["ref", "conversationId", "instructions", "wait"],
  abort: ["ref", "conversationId", "background"],
  "auth.login": ["provider"],
  "auth.answer": ["promptId", "answer"],
  "auth.cancel": ["loginId"],
};
export class Server {
  readonly instanceId = randomUUID();
  readonly reconciler: Reconciler;
  private readonly socket = new Router({
    linger: 0,
    mandatory: true,
    sendTimeout: 100,
    sendHighWaterMark: 64,
    receiveHighWaterMark: 128,
    maxMessageSize: MAX_QUEUE_BYTES,
  });
  private readonly peers = new Map<string, Peer>();
  private queue: {
    peer: Peer;
    body: Buffer;
  }[] = [];
  private queuedBytes = 0;
  private sending = false;
  private closed = false;
  private readonly prompts = new Map<string, Prompt>();
  private readonly logins = new Map<
    string,
    {
      peer: Peer;
      abort: AbortController;
    }
  >();
  private readonly timer: NodeJS.Timeout;
  private constructor(
    readonly store: Store,
    private readonly models: Models,
    private readonly deviceId: string,
  ) {
    this.reconciler = new Reconciler(
      store,
      models,
      (id, activity) => this.broadcast(id, activity),
      (id, error) => this.endStreams(id, error),
    );
    this.timer = setInterval(() => {
      for (const peer of this.peers.values())
        if (Date.now() - peer.lastSeen > 12000) this.drop(peer);
    }, 2000);
    this.timer.unref();
  }
  static async open(
    stateDir: string,
    options: {
      models?: Models;
    } = {},
  ): Promise<Server> {
    await prepareRuntimeDirectory();
    const store = await Store.open(stateDir);
    try {
      const credentials = await Credentials.open(join(store.stateDir, "auth"));
      const models =
        options.models ??
        builtinModels({
          credentials,
        });
      const server = new Server(store, models, await credentials.deviceId());
      try {
        await server.socket.bind(endpoint());
        await chmod(endpoint().slice(6), 0o600);
      } catch (error) {
        await server.close();
        throw error;
      }
      void server.receive();
      void server.reconciler.recover();
      return server;
    } catch (error) {
      await store.close().catch(() => {});
      throw error;
    }
  }
  private peer(route: Buffer): Peer {
    const key = route.toString("hex");
    let peer = this.peers.get(key);
    if (!peer) {
      if (this.peers.size >= 128)
        throw new PidError("client_limit", "Too many connected clients");
      peer = {
        key,
        route,
        session: randomUUID(),
        lastSeen: Date.now(),
        abort: new AbortController(),
        pending: new Set(),
        subscriptions: new Map(),
      };
      this.peers.set(key, peer);
    }
    peer.lastSeen = Date.now();
    return peer;
  }
  private drop(peer: Peer): void {
    if (this.peers.get(peer.key) !== peer) return;
    this.peers.delete(peer.key);
    peer.abort.abort();
    peer.subscriptions.clear();
    for (const [id, login] of this.logins)
      if (login.peer === peer) {
        login.abort.abort();
        this.logins.delete(id);
      }
    this.queue = this.queue.filter((item) => {
      if (item.peer !== peer) return true;
      this.queuedBytes -= item.body.length;
      return false;
    });
  }
  private send(peer: Peer, frame: Outbound): void {
    if (this.closed || this.peers.get(peer.key) !== peer) return;
    let body: Buffer;
    try {
      body = encode({ v: VERSION, instance: this.instanceId, ...frame });
    } catch {
      this.drop(peer);
      return;
    }
    if (
      this.queue.length >= MAX_QUEUE_ITEMS ||
      this.queuedBytes + body.length > MAX_QUEUE_BYTES
    ) {
      this.drop(peer);
      return;
    }
    this.queue.push({ peer, body });
    this.queuedBytes += body.length;
    void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.sending || this.closed) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.closed) {
        const item = this.queue.shift()!;
        this.queuedBytes -= item.body.length;
        if (this.peers.get(item.peer.key) !== item.peer) continue;
        try {
          await this.socket.send([item.peer.route, item.body]);
        } catch {
          this.drop(item.peer);
        }
      }
    } finally {
      this.sending = false;
    }
  }
  private broadcast(harness: string, activity: Activity): void {
    for (const peer of this.peers.values())
      for (const [subscriptionId, filter] of peer.subscriptions)
        if (
          filter.harness === harness &&
          (filter.conversationId === undefined ||
            filter.conversationId === activity.conversationId)
        )
          this.send(peer, { type: "activity", subscriptionId, activity });
  }
  private endStreams(harness: string, error: ErrorInfo): void {
    for (const peer of this.peers.values())
      for (const [subscriptionId, filter] of peer.subscriptions)
        if (filter.harness === harness) {
          peer.subscriptions.delete(subscriptionId);
          this.send(peer, { type: "subscription.end", subscriptionId, error });
        }
  }
  private async receive(): Promise<void> {
    try {
      for await (const frames of this.socket) {
        const route = frames[0];
        const body = frames[1];
        if (!route || !body) continue;
        let peer: Peer;
        try {
          peer = this.peer(route);
        } catch {
          continue;
        }
        let request: Request;
        try {
          request = parseRequest(body);
        } catch (error) {
          this.send(peer, {
            type: "response",
            id: "",
            error: errorInfo(error),
          });
          continue;
        }
        if (
          request.command !== "health" &&
          request.instance !== this.instanceId
        ) {
          this.send(peer, {
            type: "response",
            id: request.id,
            error: {
              code: "daemon_restarted",
              message: "Reconnect to the current daemon instance",
            },
          });
          continue;
        }
        if (peer.pending.size >= 128 || peer.pending.has(request.id)) {
          this.send(peer, {
            type: "response",
            id: request.id,
            error: {
              code: "request_limit",
              message: "Request is duplicate or exceeds client limits",
            },
          });
          continue;
        }
        peer.pending.add(request.id);
        void this.handle(peer, request)
          .then(
            (result) =>
              this.send(peer, { type: "response", id: request.id, result }),
            (error) =>
              this.send(peer, {
                type: "response",
                id: request.id,
                error: errorInfo(error),
              }),
          )
          .finally(() => peer.pending.delete(request.id));
      }
    } catch (error) {
      if (!this.closed) {
        process.stderr.write(
          JSON.stringify({ error: errorInfo(error) }) + "\n",
        );
        process.exitCode = 1;
        await this.close();
      }
    }
  }
  private async login(
    peer: Peer,
    request: Request,
  ): Promise<{
    provider: string;
    type: string;
  }> {
    const provider = textField(request.args.provider, "provider", 128);
    if (this.logins.size >= 16)
      throw new PidError(
        "auth_limit",
        "Too many active authentication sessions",
      );
    const registered = this.models.getProvider(provider);
    if (!registered)
      throw new PidError("provider_not_found", "Provider is not supported");
    const abort = new AbortController();
    this.logins.set(request.id, { peer, abort });
    const prompt = async (
      native: import("@earendil-works/pi-ai").AuthPrompt,
    ): Promise<string> => {
      const promptId = randomUUID();
      const { signal, ...wire } = native;
      if (abort.signal.aborted || signal?.aborted)
        throw new PidError("auth_cancelled", "Authentication cancelled");
      return new Promise<string>((resolve, reject) => {
        const cancel = () => {
          this.send(peer, {
            type: "auth.prompt.cancel",
            id: request.id,
            promptId,
          });
          finish(new PidError("auth_cancelled", "Authentication cancelled"));
        };
        const finish = (error?: unknown, answer?: string) => {
          this.prompts.delete(promptId);
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          abort.signal.removeEventListener("abort", cancel);
          if (error) reject(error);
          else resolve(answer!);
        };
        const timer = setTimeout(
          () =>
            finish(
              new PidError("auth_timeout", "Authentication input timed out"),
            ),
          300000,
        );
        this.prompts.set(promptId, {
          peer,
          login: request.id,
          resolve: (answer) => finish(undefined, answer),
          reject: (error) => finish(error),
        });
        signal?.addEventListener("abort", cancel, { once: true });
        abort.signal.addEventListener("abort", cancel, { once: true });
        this.send(peer, {
          type: "auth.prompt",
          id: request.id,
          promptId,
          prompt: wire,
        });
      });
    };
    try {
      const choices: ("api_key" | "oauth")[] = [];
      if (registered.auth.apiKey?.login) choices.push("api_key");
      if (registered.auth.oauth) choices.push("oauth");
      if (!choices.length)
        throw new PidError(
          "auth_unavailable",
          "This provider uses ambient authentication",
        );
      const method =
        choices.length === 1
          ? choices[0]!
          : await prompt({
              type: "select",
              message: "Authentication method",
              options: choices.map((id) => ({
                id,
                label: id === "oauth" ? "OAuth" : "API key",
              })),
            });
      if (!choices.includes(method as "api_key" | "oauth"))
        throw new PidError(
          "invalid_auth_method",
          "Invalid authentication method",
        );
      const credential = await this.models.login(
        provider,
        method as "api_key" | "oauth",
        {
          signal: abort.signal,
          prompt,
          notify: (event) =>
            this.send(peer, { type: "auth.event", id: request.id, event }),
        },
        { getDeviceId: () => this.deviceId, agentName: "PID" },
      );
      await this.models.refresh({
        providers: [provider],
        allowNetwork: true,
        signal: abort.signal,
      });
      return { provider, type: credential.type };
    } catch (error) {
      if (error instanceof PidError) throw error;
      // Provider exceptions may contain submitted keys. Do not reflect them onto the wire or logs.
      throw new PidError(
        abort.signal.aborted ? "auth_cancelled" : "auth_failed",
        abort.signal.aborted
          ? "Authentication cancelled"
          : "Provider authentication failed",
      );
    } finally {
      abort.abort();
      this.logins.delete(request.id);
    }
  }
  private async handle(peer: Peer, request: Request): Promise<unknown> {
    const a = request.args;
    for (const key of Object.keys(a))
      if (!allowed[request.command].includes(key))
        throw new PidError("invalid_request", `Unsupported argument ${key}`);
    const ref = () => textField(a.ref, "harness reference", 4096);
    switch (request.command) {
      case "health":
        return {
          stateDir: this.store.stateDir,
          pid: process.pid,
          instanceId: this.instanceId,
          clientSessionId: peer.session,
          recovering: this.reconciler.recovering,
          errors: this.reconciler
            .list()
            .filter((value) => value.error)
            .map((value) => ({ id: value.id, error: value.error })),
        };
      case "harness.list":
        return this.reconciler.list();
      case "harness.start": {
        const baseDir = textField(a.baseDir, "caller directory", 4096);
        if (!isAbsolute(baseDir))
          throw new PidError(
            "invalid_request",
            "Caller directory must be absolute",
          );
        const id = await this.store.start(
          ref(),
          a.name === undefined ? undefined : textField(a.name, "name", 128),
          baseDir,
        );
        return this.reconciler.converge(id, "running");
      }
      case "harness.stop":
      case "harness.destroy": {
        const id = this.store.resolve(ref());
        const desired =
          request.command === "harness.stop" ? "stopped" : "absent";
        this.store.desire(id, desired);
        return this.reconciler.converge(id, desired);
      }
      case "conversation.list":
        return this.reconciler.conversations(
          ref(),
          a.limit === undefined ? undefined : idField(a.limit, "limit"),
          a.cursor === undefined
            ? undefined
            : textField(a.cursor, "cursor", 8192),
        );
      case "conversation.create": {
        if (a.at !== undefined && a.fork === undefined)
          throw new PidError("invalid_request", "at requires a fork source");
        const model =
          a.model === undefined ? undefined : textField(a.model, "model", 1024);
        const options: ConversationOptions =
          a.fork === undefined
            ? { model: textField(model, "model", 1024) }
            : {
                fork: idField(a.fork, "fork"),
                ...(a.at === undefined ? {} : { at: idField(a.at, "entry") }),
                ...(model ? { model } : {}),
              };
        const id = this.store.resolve(ref());
        return this.reconciler.runtime(id).create(this.store.get(id)!, options);
      }
      case "send": {
        const whenBusy = a.whenBusy ?? "follow-up";
        const whenIdle = a.whenIdle ?? "run";
        if (
          !["follow-up", "steer", "reject"].includes(whenBusy as string) ||
          !["run", "reject"].includes(whenIdle as string)
        )
          throw new PidError("invalid_request", "Invalid delivery semantics");
        return this.reconciler.runtime(ref()).send(
          idField(a.conversationId),
          textField(a.message, "message", 1048576),
          {
            requestId: textField(a.requestId, "requestId", 256),
            whenBusy: whenBusy as "follow-up" | "steer" | "reject",
            whenIdle: whenIdle as "run" | "reject",
            wait: optionalBoolean(a.wait, "wait"),
          },
          peer.abort.signal,
        );
      }
      case "compact":
        return this.reconciler
          .runtime(ref())
          .compact(
            idField(a.conversationId),
            a.instructions === undefined
              ? undefined
              : textField(a.instructions, "instructions"),
            optionalBoolean(a.wait, "wait"),
            peer.abort.signal,
          );
      case "abort":
        return this.reconciler
          .runtime(ref())
          .abort(
            idField(a.conversationId),
            optionalBoolean(a.background, "background"),
          );
      case "watch": {
        const harness = this.store.resolve(ref());
        const runtime = this.reconciler.runtime(harness);
        const conversationId =
          a.conversationId === undefined
            ? undefined
            : idField(a.conversationId);
        if (conversationId !== undefined)
          await runtime.conversation(conversationId);
        const subscriptionId = textField(
          a.subscriptionId,
          "subscriptionId",
          128,
        );
        if (
          peer.subscriptions.size >= 128 ||
          peer.subscriptions.has(subscriptionId)
        )
          throw new PidError(
            "subscription_limit",
            "Subscription already exists or exceeds client limits",
          );
        peer.subscriptions.set(subscriptionId, { harness, conversationId });
        return { subscriptionId };
      }
      case "unwatch": {
        if (optionalBoolean(a.all, "all")) peer.subscriptions.clear();
        else
          peer.subscriptions.delete(
            textField(a.subscriptionId, "subscriptionId", 128),
          );
        return { unsubscribed: true };
      }
      case "auth.login":
        return this.login(peer, request);
      case "auth.answer": {
        const prompt = this.prompts.get(textField(a.promptId, "promptId", 128));
        if (!prompt || prompt.peer !== peer)
          throw new PidError(
            "auth_prompt_not_found",
            "Authentication prompt is no longer active",
          );
        if (typeof a.answer !== "string" || a.answer.length > 65536)
          throw new PidError(
            "invalid_request",
            "Invalid authentication answer",
          );
        prompt.resolve(a.answer);
        return { accepted: true };
      }
      case "auth.cancel": {
        const login = this.logins.get(textField(a.loginId, "loginId", 128));
        if (login?.peer === peer) login.abort.abort();
        return { cancelled: true };
      }
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const peer of this.peers.values()) this.drop(peer);
    this.socket.close();
    await this.reconciler.close();
    await this.store.close();
  }
}
