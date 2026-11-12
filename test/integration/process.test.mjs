import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "../../packages/sdk/dist/index.js";

async function ready() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      return await connect({ timeoutMs: 500 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  throw new Error("Daemon did not become ready");
}
async function kill(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}
test(
  "daemon main holds a process-lifetime lock across state directories and restores desired state after SIGKILL",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pid-process-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    const cwd = join(directory, "project");
    await mkdir(cwd);
    const main = new URL(
      "../../packages/sdk/dist/daemon/main.js",
      import.meta.url,
    ).pathname;
    let child;
    let client;
    const start = () =>
      spawn(process.execPath, [main, "--state-dir", join(directory, "state")], {
        env: process.env,
        stdio: "ignore",
      });
    try {
      child = start();
      client = await ready();
      const harness = await client.harnesses.start(cwd);
      const conversation = await client.conversations.create(harness.id, {
        model: "openai/not-a-real-model",
      });
      const competing = spawn(
        process.execPath,
        [main, "--state-dir", join(directory, "other")],
        { env: process.env, stdio: "ignore" },
      );
      const [code] = await once(competing, "exit");
      assert.equal(code, 73);
      await assert.rejects(access(join(directory, "other", "data.mdb")));
      await kill(child, "SIGKILL");
      await client.close();
      client = undefined;
      child = start();
      client = await ready();
      assert.equal((await client.harnesses.list())[0].id, harness.id);
      assert.equal(
        (await client.conversations.list(harness.id)).items[0].id,
        conversation.id,
      );
      await client.harnesses.stop(harness.id);
      await kill(child, "SIGKILL");
      await client.close();
      client = undefined;
      child = start();
      client = await ready();
      assert.equal((await client.harnesses.list())[0].actual, "stopped");
      assert.equal(
        (await client.conversations.list(harness.id)).items[0].id,
        conversation.id,
      );
      await client.harnesses.destroy(harness.id);
    } finally {
      await client?.close();
      await kill(child);
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
