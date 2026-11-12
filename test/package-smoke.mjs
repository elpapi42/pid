import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "pid-packages-"));
let daemon;
try {
  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts);
  const packs = {};
  for (const kind of ["sdk", "cli"]) {
    const { stdout } = await execute(
      "npm",
      [
        "pack",
        "-w",
        `@elpapi42/pid-${kind}`,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        artifacts,
      ],
      { cwd: root },
    );
    const result = JSON.parse(stdout);
    const packed = Array.isArray(result)
      ? result[0]
      : result[`@elpapi42/pid-${kind}`];
    assert.ok(packed.files.some((file) => file.path === "README.md"));
    assert.ok(
      packed.files.some(
        (file) =>
          file.path === "dist/index.d.ts" || file.path === "dist/main.js",
      ),
    );
    packs[kind] = join(artifacts, packed.filename);
  }
  const sdkProject = join(directory, "sdk-only");
  const cliProject = join(directory, "cli-consumer");
  for (const project of [sdkProject, cliProject]) {
    await mkdir(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
  }
  await execute(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", packs.sdk],
    { cwd: sdkProject, timeout: 120000, maxBuffer: 1048576 },
  );
  await assert.rejects(
    access(join(sdkProject, "node_modules", "@elpapi42", "pid-cli")),
  );
  const sdkDirectory = join(sdkProject, "node_modules", "@elpapi42", "pid-sdk");
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: join(directory, "run"),
    XDG_CONFIG_HOME: join(directory, "config"),
  };
  const bin = join(directory, "bin");
  await mkdir(bin);
  env.PATH = bin + ":" + process.env.PATH;
  for (const program of ["systemctl", "loginctl"])
    await writeFile(
      join(bin, program),
      `#!/bin/sh\nif [ "$1" = "show-user" ]; then echo yes; fi\n`,
      { mode: 0o755 },
    );
  daemon = spawn(
    process.execPath,
    [
      join(sdkDirectory, "dist", "daemon", "main.js"),
      "--state-dir",
      join(directory, "state"),
    ],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let daemonError = "";
  daemon.stderr.on("data", (chunk) => {
    daemonError += chunk;
  });
  const project = join(directory, "project");
  await mkdir(project);
  const consumer = join(sdkProject, "consumer.mjs");
  await writeFile(
    consumer,
    `
import assert from "node:assert/strict";
import { connect, startDaemon } from "@elpapi42/pid-sdk";
let client;
for(let attempt=0;attempt<50;attempt++) {
  try { client=await connect({timeoutMs:300}); break; } catch { await new Promise(resolve=>setTimeout(resolve,30)); }
}
assert.ok(client,"packed daemon readiness");
try {
  const info=await startDaemon({stateDir:${JSON.stringify(join(directory, "state"))},timeoutMs:5000});
  assert.equal(info.stateDir,${JSON.stringify(join(directory, "state"))});
  const harness=await client.harnesses.start(${JSON.stringify(project)},{name:"packed"});
  const conversation=await client.conversations.create(harness.id,{model:"openai/gpt-4.1-nano"});
  const watch=await client.watch(harness.id); await watch.close();
  assert.equal((await client.conversations.list("packed")).items[0].id,conversation.id);
  await client.harnesses.stop("packed");
  assert.equal((await client.conversations.list("packed")).items[0].id,conversation.id);
  console.log(JSON.stringify({sdkOnly:true,harnessId:harness.id,conversationId:conversation.id}));
} finally {await client.close();}
`,
  );
  const sdkResult = await execute(process.execPath, [consumer], {
    cwd: sdkProject,
    env,
    timeout: 20000,
  });
  const sdkProof = JSON.parse(sdkResult.stdout);
  assert.equal(sdkProof.sdkOnly, true);
  assert.equal(sdkResult.stderr, "");
  await writeFile(
    join(sdkProject, "types.ts"),
    `
import {connect, type Activity} from "@elpapi42/pid-sdk";
const client=await connect();
const receipt=await client.send("packed",1,"test",{wait:true});
const status: "done"|"unanswered"|undefined=receipt.settlement?.status;
function text(item:Activity): string|undefined {if(item.type==="assistant_message") return item.text;}
await client.close();
`,
  );
  await execute(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--skipLibCheck",
      "--strict",
      "--module",
      "nodenext",
      "--target",
      "es2023",
      "types.ts",
    ],
    { cwd: sdkProject },
  );
  const unit = await readFile(
    join(directory, "config", "systemd", "user", "pid.service"),
    "utf8",
  );
  assert.ok(unit.includes(join(sdkDirectory, "dist", "daemon", "main.js")));
  await execute(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      packs.sdk,
      packs.cli,
    ],
    { cwd: cliProject, timeout: 120000, maxBuffer: 1048576 },
  );
  const pid = join(cliProject, "node_modules", ".bin", "pid");
  assert.equal((await execute(pid, ["--version"], { env })).stdout, "0.1.0\n");
  assert.match((await execute(pid, ["--help"], { env })).stdout, /Usage: pid/);
  const version = await execute(pid, ["--version", "--json"], { env });
  assert.equal(JSON.parse(version.stdout).version, "0.1.0");
  assert.match(
    (await execute(pid, ["harness", "list"], { env })).stdout,
    /DESIRED/,
  );
  const listed = await execute(pid, ["harness", "list", "--json"], { env });
  assert.equal(JSON.parse(listed.stdout)[0].id, sdkProof.harnessId);
  assert.equal(listed.stderr, "");
  const conversations = await execute(
    pid,
    ["conversation", "list", "packed", "--json"],
    {
      env,
    },
  );
  assert.equal(
    JSON.parse(conversations.stdout).items[0].id,
    sdkProof.conversationId,
  );
  await execute(pid, ["harness", "destroy", "packed"], { env });
  assert.deepEqual(
    JSON.parse(
      (await execute(pid, ["harness", "list", "--json"], { env })).stdout,
    ),
    [],
  );
  assert.equal(daemonError, "");
  console.log(
    JSON.stringify({
      sdkOnly: "passed",
      packedDaemon: "passed",
      packedBootstrap: "passed",
      packedCli: "passed",
    }),
  );
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill("SIGTERM");
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
