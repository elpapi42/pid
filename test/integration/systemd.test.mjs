import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "../../packages/sdk/dist/index.js";
import { Runtime } from "../../packages/sdk/dist/daemon/harness.js";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
const exec = promisify(execFile);
async function eventually(action, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw last ?? new Error("Timed out");
}

test(
  "real disposable systemd service restarts a crashed daemon and Durable resumes the accepted submission",
  { timeout: 40000 },
  async (t) => {
    const previous = process.env.XDG_RUNTIME_DIR;
    const busEnv = {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS:
        process.env.DBUS_SESSION_BUS_ADDRESS ||
        `unix:path=${previous || `/run/user/${process.getuid()}`}/bus`,
    };
    try {
      await exec("systemctl", ["--user", "is-system-running"], {
        env: busEnv,
        timeout: 3000,
      });
    } catch {
      t.skip("No reachable user systemd manager");
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "pid-systemd-"));
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    await mkdir(join(directory, "run", "pid"), {
      recursive: true,
      mode: 0o700,
    });
    const state = join(directory, "state");
    const marker = join(directory, "calls");
    const cwd = join(directory, "project");
    await mkdir(cwd);
    const unit = `pid-test-${randomUUID().slice(0, 8)}.service`;
    const fixture = new URL("../fixtures/service-daemon.mjs", import.meta.url)
      .pathname;
    let client;
    let started = false;
    try {
      await exec(
        "systemd-run",
        [
          "--user",
          `--unit=${unit}`,
          "--collect",
          "--property=Type=exec",
          "--property=Restart=always",
          "--property=RestartSec=300ms",
          "--property=KillMode=control-group",
          `--setenv=XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR}`,
          "/usr/bin/flock",
          "--exclusive",
          "--nonblock",
          "--no-fork",
          join(directory, "run", "pid", "daemon.lock"),
          process.execPath,
          fixture,
          state,
          marker,
        ],
        { env: busEnv },
      );
      started = true;
      client = await eventually(() => connect({ timeoutMs: 700 }));
      const harness = await client.harnesses.start(cwd);
      const conversation = await client.conversations.create(harness.id, {
        model: "faux/faux-1",
      });
      const receipt = await client.send(
        harness.id,
        conversation.id,
        "durable work",
        { requestId: "systemd-recovery" },
      );
      await eventually(
        async () => Number(await readFile(marker, "utf8")) === 1,
      );
      const oldPid = (
        await exec(
          "systemctl",
          ["--user", "show", unit, "--property=MainPID", "--value"],
          { env: busEnv },
        )
      ).stdout.trim();
      await exec("systemctl", ["--user", "kill", "--signal=SIGKILL", unit], {
        env: busEnv,
      });
      await client.close();
      client = undefined;
      await eventually(async () => {
        const value = (
          await exec(
            "systemctl",
            ["--user", "show", unit, "--property=MainPID", "--value"],
            { env: busEnv },
          )
        ).stdout.trim();
        return value !== "0" && value !== oldPid;
      });
      client = await eventually(() => connect({ timeoutMs: 700 }));
      await eventually(
        async () => (await client.harnesses.list())[0]?.actual === "running",
      );
      const resumed = await client.send(
        harness.id,
        conversation.id,
        "durable work",
        { requestId: "systemd-recovery", wait: true },
      );
      assert.equal(resumed.submissionId, receipt.submissionId);
      assert.equal(resumed.settlement.status, "done");
      assert.equal(Number(await readFile(marker, "utf8")), 2);
      await client.harnesses.stop(harness.id);
      const reader = await Runtime.open(
        join(state, "harnesses", harness.id, "session.sqlite"),
        { cwd, desired: "stopped" },
        createModels(),
        { readOnly: true },
      );
      try {
        const native = await reader.conversation(conversation.id);
        const entries = await native.entries(
          {},
          100,
          undefined,
          BACKGROUND_CONTEXT,
        );
        assert.equal(
          entries.items.filter((entry) => entry.kind === "pi.user").length,
          1,
        );
      } finally {
        await reader.close();
      }
      await exec("systemctl", ["--user", "restart", unit], { env: busEnv });
      await client.close();
      client = undefined;
      client = await eventually(() => connect({ timeoutMs: 700 }));
      assert.equal((await client.harnesses.list())[0].actual, "stopped");
    } finally {
      await client?.close();
      if (started)
        await exec("systemctl", ["--user", "stop", unit], {
          env: busEnv,
        }).catch(() => {});
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
