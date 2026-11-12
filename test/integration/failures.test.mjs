import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { connect } from "../../packages/sdk/dist/index.js";
import { Server } from "../../packages/sdk/dist/daemon/server.js";

async function eventually(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Condition did not become true");
}

test(
  "lost send acknowledgment retains request ID, retry deduplicates, and slow watch readers terminate without stopping execution",
  { timeout: 20000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pid-failures-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    const cwd = join(directory, "project");
    await mkdir(cwd);
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("only once"),
      fauxAssistantMessage("still running"),
    ]);
    let server;
    let client;
    let impatient;
    try {
      server = await Server.open(join(directory, "state"), { models });
      client = await connect();
      const harness = await client.harnesses.start(cwd);
      const conversation = await client.conversations.create(harness.id, {
        model: "faux/faux-1",
      });
      impatient = await connect({ timeoutMs: 80 });
      const send = server.send.bind(server);
      let dropped = false;
      server.send = (peer, frame) => {
        if (
          !dropped &&
          frame.type === "response" &&
          frame.result?.requestId === "uncertain-1"
        ) {
          dropped = true;
          return;
        }
        send(peer, frame);
      };
      await assert.rejects(
        impatient.send(harness.id, conversation.id, "hello", {
          requestId: "uncertain-1",
        }),
        (error) =>
          error.code === "delivery_uncertain" &&
          error.details.requestId === "uncertain-1",
      );
      const retry = await client.send(harness.id, conversation.id, "hello", {
        requestId: "uncertain-1",
        wait: true,
      });
      assert.equal(retry.settlement.status, "done");
      assert.equal(faux.state.callCount, 1);
      const stream = await client.watch(harness.id);
      const runtime = server.reconciler.runtime(harness.id);
      // Native extension-created entries exercise the real commit observer and ZeroMQ path.
      for (let batch = 0; batch < 110; batch++) {
        await runtime.native.commit(async (tx) => {
          for (let index = 0; index < 10; index++)
            await tx.appendEntry(conversation.id, {
              kind: "test.passive",
              model: [
                {
                  role: "user",
                  content: `activity ${batch}:${index}`,
                  timestamp: Date.now(),
                },
              ],
            });
        }, context);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      await eventually(() => client.streams.size === 0);
      await assert.rejects(
        stream[Symbol.asyncIterator]().next(),
        (error) => error.code === "activity_overflow",
      );
      assert.equal((await client.harnesses.list())[0].actual, "running");
      assert.equal(
        (
          await client.send(harness.id, conversation.id, "continue", {
            wait: true,
          })
        ).settlement.status,
        "done",
      );
      assert.equal(faux.state.callCount, 2);
    } finally {
      await impatient?.close();
      await client?.close();
      await server?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "failed stop retains runtime ownership, and failed destruction keeps absent intent across restart without removing the project",
  { timeout: 10000 },
  async () => {
    assert.notEqual(
      process.getuid(),
      0,
      "permission failure proof requires an unprivileged user",
    );
    const directory = await mkdtemp(join(tmpdir(), "pid-delete-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    const cwd = join(directory, "project");
    await mkdir(cwd);
    await writeFile(join(cwd, "keep"), "user data");
    const stateDir = join(directory, "state");
    const owned = join(stateDir, "harnesses");
    const models = createModels();
    let server;
    let client;
    try {
      server = await Server.open(stateDir, { models });
      client = await connect();
      const harness = await client.harnesses.start(cwd);
      const runtime = server.reconciler.runtime(harness.id);
      const close = runtime.close.bind(runtime);
      let failed = false;
      runtime.close = async () => {
        if (!failed) {
          failed = true;
          throw new Error("injected close failure");
        }
        return close();
      };
      await assert.rejects(
        client.harnesses.stop(harness.id),
        (error) => error.code === "reconcile_failed",
      );
      assert.equal(server.store.get(harness.id).desired, "stopped");
      assert.equal(server.reconciler.states.get(harness.id).runtime, runtime);
      assert.equal((await client.harnesses.stop(harness.id)).actual, "stopped");
      await client.harnesses.start(harness.id);
      await chmod(owned, 0o500);
      await assert.rejects(
        client.harnesses.destroy(harness.id),
        (error) => error.code === "reconcile_failed",
      );
      assert.equal(server.store.get(harness.id).desired, "absent");
      await assert.rejects(
        client.harnesses.start(harness.id),
        (error) => error.code === "harness_destroying",
      );
      await client.close();
      client = undefined;
      await server.close();
      server = undefined;
      await chmod(owned, 0o700);
      server = await Server.open(stateDir, { models });
      client = await connect();
      await eventually(() => server.store.get(harness.id) === undefined);
      assert.deepEqual(await client.harnesses.list(), []);
      assert.equal(await readFile(join(cwd, "keep"), "utf8"), "user data");
    } finally {
      await chmod(owned, 0o700).catch(() => {});
      await client?.close();
      await server?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
