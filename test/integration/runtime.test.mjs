import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxThinking,
} from "@earendil-works/pi-ai";
import { connect } from "../../packages/sdk/dist/index.js";
import { Server } from "../../packages/sdk/dist/daemon/server.js";

const execute = promisify(execFile);
async function eventually(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Condition did not become true");
}
const cli = new URL("../../packages/cli/dist/main.js", import.meta.url)
  .pathname;

test(
  "real ZeroMQ multi-client flow, JSON CLI, live-only watch, per-conversation models and restart reconciliation",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pid-integration-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    const cwd = join(directory, "project");
    await mkdir(cwd);
    await writeFile(join(cwd, "keep.txt"), "user data");
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxThinking("reasoning"),
        { type: "text", text: "first answer" },
      ]),
      fauxAssistantMessage("second answer"),
    ]);
    let server;
    let a;
    let b;
    let watcher;
    try {
      server = await Server.open(join(directory, "state"), { models });
      a = await connect();
      b = await connect();
      const [harness, duplicate] = await Promise.all([
        a.harnesses.start(cwd, { name: "worker" }),
        b.harnesses.start(cwd, { name: "worker" }),
      ]);
      assert.match(harness.id, /^[a-z0-9]{6}$/);
      assert.equal(duplicate.id, harness.id);
      assert.equal(harness.actual, "running");
      assert.deepEqual(Object.keys(server.store.get(harness.id)).sort(), [
        "cwd",
        "desired",
        "name",
      ]);
      const conversation = await a.conversations.create("worker", {
        model: "faux/faux-1",
      });
      const stream = await b.watch(harness.id, {
        conversationId: conversation.id,
      });
      const events = [];
      let streamError;
      const reading = (async () => {
        for await (const event of stream) events.push(event);
      })().catch((error) => {
        streamError = error;
      });
      const submitted = await a.send("worker", conversation.id, "first", {
        wait: true,
        requestId: "request-1",
      });
      assert.equal(submitted.settlement.status, "done");
      await eventually(() => events.length === 3);
      assert.deepEqual(
        events.map((event) => event.type),
        ["user_message", "thinking", "assistant_message"],
      );
      assert.equal(
        (
          await b.send(harness.id, conversation.id, "first", {
            wait: true,
            requestId: "request-1",
          })
        ).submissionId,
        submitted.submissionId,
      );
      assert.equal(faux.state.callCount, 1);
      await assert.rejects(
        a.send(harness.id, conversation.id, "only while working", {
          whenIdle: "reject",
        }),
        (error) => error.code === "conversation_idle",
      );
      const fork = await a.conversations.create(harness.id, {
        fork: conversation.id,
      });
      assert.equal(fork.model, "faux/faux-1");
      assert.equal(fork.parent.conversationId, conversation.id);
      assert.equal((await b.conversations.list("worker")).items.length, 2);
      const late = await a.watch("worker");
      let replayed = 0;
      const lateReader = (async () => {
        for await (const event of late) replayed++;
      })();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(replayed, 0);
      await late.close();
      await lateReader;
      const listed = await execute(
        process.execPath,
        [cli, "--json", "harness", "list"],
        {
          env: process.env,
        },
      );
      assert.equal(JSON.parse(listed.stdout)[0].id, harness.id);
      assert.equal(listed.stderr, "");
      const listedConversations = await execute(
        process.execPath,
        [cli, "--json", "conversation", "list", "worker", "--limit", "1"],
        { env: process.env },
      );
      assert.equal(JSON.parse(listedConversations.stdout).items.length, 1);
      const otherProject = join(directory, "another-project");
      await mkdir(otherProject);
      const relative = await execute(
        process.execPath,
        [cli, "--json", "harness", "start", ".", "--name", "relative"],
        { cwd: otherProject, env: process.env },
      );
      const relativeHarness = JSON.parse(relative.stdout);
      assert.equal(relativeHarness.cwd, otherProject);
      await b.harnesses.destroy(relativeHarness.id);
      await a.harnesses.stop("worker");
      await reading;
      assert.equal(streamError.code, "harness_stopped");
      await assert.rejects(
        b.send(harness.id, conversation.id, "must stay stopped"),
        (error) => error.code === "harness_stopped",
      );
      assert.equal((await a.conversations.list(harness.id)).items.length, 2);
      assert.equal(faux.state.callCount, 1);
      await server.close();
      server = undefined;
      await a.close();
      await b.close();
      a = b = undefined;
      server = await Server.open(join(directory, "state"), { models });
      a = await connect();
      assert.equal((await a.harnesses.list())[0].actual, "stopped");
      assert.equal((await a.conversations.list(harness.id)).items.length, 2);
      await a.harnesses.start(harness.id);
      watcher = spawn(
        process.execPath,
        [cli, "--json", "watch", harness.id, "--conversation", String(fork.id)],
        { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let jsonl = "";
      let diagnostic = "";
      watcher.stdout.on("data", (chunk) => {
        jsonl += chunk;
      });
      watcher.stderr.on("data", (chunk) => {
        diagnostic += chunk;
      });
      await eventually(() =>
        [...server.peers.values()].some(
          (peer) => peer.subscriptions.size === 1,
        ),
      );
      assert.equal(
        (await a.send(harness.id, fork.id, "second", { wait: true })).settlement
          .status,
        "done",
      );
      await eventually(() => jsonl.trim().split("\n").length === 2);
      const lines = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        lines.map((event) => event.type),
        ["user_message", "assistant_message"],
      );
      assert.ok(lines.every((event) => event.conversationId === fork.id));
      const exited = once(watcher, "exit");
      watcher.kill("SIGTERM");
      await exited;
      watcher = undefined;
      for (const line of diagnostic.trim().split("\n").filter(Boolean))
        assert.ok(JSON.parse(line).error);
      assert.equal((await a.harnesses.list())[0].actual, "running");
      await a.close();
      a = undefined;
      await server.close();
      server = undefined;
      server = await Server.open(join(directory, "state"), { models });
      a = await connect();
      await eventually(
        async () => (await a.harnesses.list())[0].actual === "running",
      );
      assert.equal((await a.harnesses.destroy(harness.id)).actual, "absent");
      assert.deepEqual(await a.harnesses.list(), []);
      await access(join(cwd, "keep.txt"));
      await assert.rejects(
        access(join(directory, "state", "harnesses", harness.id)),
      );
    } finally {
      if (watcher && watcher.exitCode === null && watcher.signalCode === null) {
        const exited = once(watcher, "exit");
        watcher.kill("SIGTERM");
        await exited;
      }
      await a?.close();
      await b?.close();
      await server?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
