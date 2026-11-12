import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import { Server } from "../../packages/sdk/dist/daemon/server.js";
import { startDaemon } from "../../packages/sdk/dist/index.js";

const execute = promisify(execFile);
test(
  "bootstrap writes a persistent valid unit, serializes clients, preserves configured state and reports setup failures",
  { timeout: 20000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pid-bootstrap-"));
    const keys = [
      "XDG_RUNTIME_DIR",
      "XDG_CONFIG_HOME",
      "PATH",
      "PID_COMMAND_LOG",
      "PID_LINGER_FILE",
      "PID_FAIL_COMMAND",
    ];
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    process.env.XDG_CONFIG_HOME = join(directory, "config");
    const bin = join(directory, "bin");
    await mkdir(bin);
    process.env.PATH = bin + ":" + process.env.PATH;
    process.env.PID_COMMAND_LOG = join(directory, "commands.jsonl");
    process.env.PID_LINGER_FILE = join(directory, "linger");
    const script = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const program = path.basename(process.argv[1]); const args = process.argv.slice(2);
fs.appendFileSync(process.env.PID_COMMAND_LOG, JSON.stringify({program,args})+'\\n');
if (args.includes(process.env.PID_FAIL_COMMAND)) process.exit(1);
if(program==='loginctl' && args[0]==='show-user') console.log(fs.existsSync(process.env.PID_LINGER_FILE)?'yes':'no');
if(program==='loginctl' && args[0]==='enable-linger') fs.writeFileSync(process.env.PID_LINGER_FILE,'yes');
`;
    for (const command of ["systemctl", "loginctl"])
      await writeFile(join(bin, command), script, { mode: 0o755 });
    const state = join(directory, "state with % and $literal");
    let server;
    try {
      server = await Server.open(state, { models: createModels() });
      const [a, b] = await Promise.all([
        startDaemon({ stateDir: state }),
        startDaemon({ stateDir: state }),
      ]);
      assert.equal(a.stateDir, state);
      assert.equal(b.pid, process.pid);
      const file = join(directory, "config", "systemd", "user", "pid.service");
      const unit = await readFile(file, "utf8");
      const before = await stat(file);
      assert.ok(unit.includes("Restart=always"));
      assert.ok(unit.includes("%%"));
      assert.ok(unit.includes("$$literal"));
      assert.ok(unit.includes("dist/daemon/main.js"));
      assert.ok(!unit.includes("pid daemon start"));
      assert.equal(before.mode & 0o777, 0o600);
      const commands = (await readFile(process.env.PID_COMMAND_LOG, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        commands.filter((command) => command.args.includes("daemon-reload"))
          .length,
        2,
      );
      assert.equal(
        commands.filter((command) => command.args.includes("restart")).length,
        1,
      );
      assert.equal((await startDaemon()).stateDir, state);
      assert.equal((await stat(file)).ino, before.ino);
      const cli = new URL("../../packages/cli/dist/main.js", import.meta.url)
        .pathname;
      const human = await execute(process.execPath, [cli, "daemon", "start"], {
        env: process.env,
      });
      assert.match(human.stdout, /Daemon is ready/);
      assert.ok(human.stdout.includes(state));
      assert.equal(human.stderr, "");
      const machine = await execute(
        process.execPath,
        [cli, "daemon", "start", "--json"],
        { env: process.env },
      );
      assert.equal(JSON.parse(machine.stdout).stateDir, state);
      assert.equal(machine.stderr, "");
      assert.equal((await stat(file)).ino, before.ino);
      await assert.rejects(
        startDaemon({ stateDir: join(directory, "other") }),
        (error) => error.code === "state_dir_conflict",
      );
      assert.equal(await readFile(file, "utf8"), unit);
      process.env.PID_FAIL_COMMAND = "enable";
      await assert.rejects(
        startDaemon(),
        (error) => error.code === "service_setup_failed",
      );
      delete process.env.PID_FAIL_COMMAND;
      // An interrupted first application must retry reload/restart instead of treating the file as applied.
      await writeFile(file, unit + "# PID configuration pending readiness\n");
      process.env.PID_FAIL_COMMAND = "daemon-reload";
      await assert.rejects(
        startDaemon(),
        (error) => error.code === "service_setup_failed",
      );
      assert.ok((await readFile(file, "utf8")).includes("pending readiness"));
      delete process.env.PID_FAIL_COMMAND;
      await startDaemon();
      assert.equal(await readFile(file, "utf8"), unit);
      await writeFile(file, "[Unit]\nDescription=Unrelated existing service\n");
      await assert.rejects(
        startDaemon(),
        (error) => error.code === "service_conflict",
      );
      assert.ok(
        (await readFile(file, "utf8")).includes("Unrelated existing service"),
      );
      await writeFile(file, unit);
      // Actual systemd parser validates the generated unit without installing it into the user's manager.
      await execute("/usr/bin/systemd-analyze", ["--user", "verify", file], {
        env: { ...process.env, PATH: previous.PATH },
      });
    } finally {
      await server?.close();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
