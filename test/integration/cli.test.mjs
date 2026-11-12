import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxThinking,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Server } from "../../packages/sdk/dist/daemon/server.js";
import { connect } from "../../packages/sdk/dist/index.js";
const execute = promisify(execFile);
const cli = new URL("../../packages/cli/dist/main.js", import.meta.url)
  .pathname;
async function eventually(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Condition did not become true");
}

test(
  "human CLI lifecycle, conversation controls, and concurrent human/JSON watch work through the SDK",
  { timeout: 20000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pid-human-cli-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    const project = join(directory, "project");
    await mkdir(project);
    await writeFile(join(project, "keep"), "project data");
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxThinking("checking"),
        { type: "text", text: "Answer" },
      ]),
    ]);
    const env = { ...process.env, NO_COLOR: "1" };
    const run = (...args) =>
      execute(process.execPath, [cli, ...args], { env, timeout: 10000 });
    let server;
    let client;
    const children = [];
    try {
      server = await Server.open(join(directory, "state"), { models });
      client = await connect();
      assert.match((await run("harness", "list")).stdout, /No harnesses/);
      const start = await run("harness", "start", project, "--name", "worker");
      assert.match(start.stdout, /is running/);
      assert.equal(start.stderr, "");
      const harness = (await client.harnesses.list())[0];
      const humanList = await run("harness", "list");
      assert.match(humanList.stdout, /DESIRED.*ACTUAL/);
      assert.ok(humanList.stdout.includes(harness.id));
      assert.ok(!humanList.stdout.includes("\u001b"));
      for (const args of [
        ["--json", "harness", "list"],
        ["harness", "--json", "list"],
        ["harness", "list", "--json"],
      ])
        assert.deepEqual(
          JSON.parse((await run(...args)).stdout),
          await client.harnesses.list(),
        );
      assert.match(
        (
          await run(
            "conversation",
            "create",
            "worker",
            "--model",
            "faux/faux-1",
          )
        ).stdout,
        /Send a message: pid send worker/,
      );
      const conversation = (await client.conversations.list("worker")).items[0];
      const watching = [];
      for (const json of [false, true]) {
        const child = spawn(
          process.execPath,
          [
            cli,
            "watch",
            "worker",
            "--conversation",
            String(conversation.id),
            ...(json ? ["--json"] : []),
          ],
          { env, stdio: ["ignore", "pipe", "pipe"] },
        );
        const captured = { child, json, stdout: "", stderr: "" };
        children.push(child);
        watching.push(captured);
        child.stdout.on("data", (chunk) => {
          captured.stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          captured.stderr += chunk;
        });
      }
      await eventually(
        () =>
          [...server.peers.values()].filter((peer) => peer.subscriptions.size)
            .length === 2,
      );
      const receipt = await run(
        "send",
        "worker",
        String(conversation.id),
        "Hello",
        "--wait",
      );
      assert.match(receipt.stdout, /Submission .*completed/);
      assert.equal(receipt.stderr, "");
      const [human, machine] = watching;
      await eventually(
        () =>
          human.stdout.includes("Answer") &&
          machine.stdout.trim().split("\n").length === 3,
      );
      assert.match(human.stdout, /You\nHello/);
      assert.match(human.stdout, /Thinking\nchecking/);
      assert.match(human.stdout, /Assistant\nAnswer/);
      assert.match(human.stderr, /New activity only/);
      assert.deepEqual(
        machine.stdout
          .trim()
          .split("\n")
          .map((value) => JSON.parse(value).type),
        ["user_message", "thinking", "assistant_message"],
      );
      assert.equal(machine.stderr, "");
      // Closing a downstream pipe ends that listener without aborting agent work.
      const pipeExited = once(machine.child, "exit");
      machine.child.stdout.destroy();
      await server.reconciler
        .runtime(harness.id)
        .native.commit(
          (tx) =>
            tx.appendEntry(conversation.id, {
              kind: "test.passive",
              model: [
                { role: "user", content: "pipe check", timestamp: Date.now() },
              ],
            }),
          context,
        );
      assert.equal((await pipeExited)[0], 0);
      const exited = once(human.child, "exit");
      human.child.kill("SIGINT");
      assert.equal((await exited)[0], 130);
      assert.equal((await client.harnesses.list())[0].actual, "running");
      assert.match(
        (
          await run(
            "conversation",
            "create",
            "worker",
            "--fork",
            String(conversation.id),
          )
        ).stdout,
        /Forked from conversation/,
      );
      const page = JSON.parse(
        (await run("conversation", "list", "worker", "--limit", "1", "--json"))
          .stdout,
      );
      assert.equal(page.items.length, 1);
      assert.ok(page.next);
      assert.match(
        (await run("conversation", "list", "worker", "--limit", "1")).stdout,
        /More: pid conversation list worker --cursor/,
      );
      assert.match(
        (await run("compact", "worker", String(conversation.id), "--wait"))
          .stdout,
        /Compaction task .*completed/,
      );
      const compact = JSON.parse(
        (
          await run(
            "compact",
            "worker",
            String(conversation.id),
            "--wait",
            "--json",
          )
        ).stdout,
      );
      assert.equal(compact.outcome.status, "completed");
      assert.match(
        (await run("abort", "worker", String(conversation.id), "--background"))
          .stdout,
        /including background tasks/,
      );
      assert.deepEqual(
        JSON.parse(
          (await run("abort", "worker", String(conversation.id), "--json"))
            .stdout,
        ),
        { aborted: true },
      );
      assert.match(
        (await run("harness", "stop", "worker")).stdout,
        /is stopped/,
      );
      assert.match(
        (await run("conversation", "list", "worker")).stdout,
        /faux\/faux-1/,
      );
      assert.equal(
        JSON.parse((await run("harness", "start", "worker", "--json")).stdout)
          .id,
        harness.id,
      );
      assert.match(
        (await run("harness", "destroy", "worker")).stdout,
        /project directory and shared credentials were preserved/,
      );
      assert.equal(
        await readFile(join(project, "keep"), "utf8"),
        "project data",
      );
      assert.deepEqual(await client.harnesses.list(), []);
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const done = once(child, "exit");
          child.kill("SIGTERM");
          await done;
        }
      await client?.close();
      await server?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
