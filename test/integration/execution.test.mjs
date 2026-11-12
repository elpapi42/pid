import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { connect } from "../../packages/sdk/dist/index.js";
import { Server } from "../../packages/sdk/dist/daemon/server.js";

test(
  "busy rejection, steering, follow-ups, abort, and committed compaction use native execution semantics",
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pid-execution-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    const cwd = join(directory, "project");
    await mkdir(cwd);
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    let release;
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    faux.setResponses([
      async () => {
        entered();
        await gate;
        return fauxAssistantMessage("first answer");
      },
      ...Array.from({ length: 5 }, () => fauxAssistantMessage("next answer")),
    ]);
    let server;
    let client;
    let stream;
    try {
      server = await Server.open(join(directory, "state"), { models });
      client = await connect();
      const harness = await client.harnesses.start(cwd);
      const conversation = await client.conversations.create(harness.id, {
        model: "faux/faux-1",
      });
      const initial = client.send(harness.id, conversation.id, "initial", {
        wait: true,
      });
      await started;
      await assert.rejects(
        client.send(harness.id, conversation.id, "reject", {
          whenBusy: "reject",
        }),
        (error) => error.code === "conversation_busy",
      );
      const follow = await client.send(harness.id, conversation.id, "follow", {
        whenBusy: "follow-up",
        requestId: "follow",
      });
      const steer = await client.send(harness.id, conversation.id, "steer", {
        whenBusy: "steer",
        requestId: "steer",
      });
      assert.notEqual(follow.submissionId, steer.submissionId);
      release();
      assert.equal((await initial).settlement.status, "done");
      assert.equal(
        (
          await client.send(harness.id, conversation.id, "follow", {
            requestId: "follow",
            wait: true,
          })
        ).settlement.status,
        "done",
      );
      assert.equal(
        (
          await client.send(harness.id, conversation.id, "steer", {
            requestId: "steer",
            wait: true,
          })
        ).settlement.status,
        "done",
      );
      const runtime = server.reconciler.runtime(harness.id);
      const native = await runtime.conversation(conversation.id);
      const view = await native.context(context);
      const userText = view.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content);
      assert.equal(userText.filter((text) => text === "follow").length, 1);
      assert.equal(userText.filter((text) => text === "steer").length, 1);
      assert.ok(!userText.includes("reject"));
      // Keep a small tail so this compact operation must produce and place a real summary.
      await native.configure({ compaction: { keepRecentTokens: 0 } }, context);
      faux.setResponses([fauxAssistantMessage("Checkpoint summary")]);
      const events = [];
      stream = await client.watch(harness.id);
      const reading = (async () => {
        for await (const event of stream) events.push(event);
      })();
      const compacted = await client.compact(harness.id, conversation.id, {
        instructions: "Keep decisions",
        wait: true,
      });
      assert.equal(compacted.outcome.status, "completed");
      assert.equal(compacted.settlement.status, "done");
      assert.equal((await native.context(context)).head.kind, "pi.compaction");
      await stream.close();
      await reading;
      assert.deepEqual(
        events,
        [],
        "internal compaction summaries are not assistant activity",
      );
      let generating;
      const generatingPromise = new Promise((resolve) => {
        generating = resolve;
      });
      faux.setResponses([
        async (_transcript, options) => {
          generating();
          await new Promise((resolve, reject) => {
            if (options.signal.aborted) reject(new Error("aborted"));
            else
              options.signal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
          });
          return fauxAssistantMessage("unreachable");
        },
      ]);
      const running = client.send(harness.id, conversation.id, "abort me", {
        wait: true,
      });
      await generatingPromise;
      assert.deepEqual(
        await client.abort(harness.id, conversation.id, { background: true }),
        { aborted: true },
      );
      assert.equal((await running).settlement.status, "unanswered");
      assert.equal((await runtime.native.inspect(context)).tasks.length, 0);
    } finally {
      release?.();
      await stream?.close();
      await client?.close();
      await server?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
