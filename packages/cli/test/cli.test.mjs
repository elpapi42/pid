import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const exec = promisify(execFile);
const cli = new URL("../dist/main.js", import.meta.url).pathname;
const env = {
  ...process.env,
  XDG_RUNTIME_DIR: "/tmp/no-pid-cli-test-daemon",
  NO_COLOR: "1",
};

test("help is readable, command-specific, and works without a daemon", async () => {
  for (const args of [
    [],
    ["--help"],
    ["harness", "--help"],
    ["help", "harness", "start"],
    ["harness", "start", "--help"],
  ]) {
    const result = await exec(process.execPath, [cli, ...args], { env });
    assert.match(result.stdout, /Usage: pid/);
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes("\u001b"));
  }
  const result = await exec(
    process.execPath,
    [cli, "conversation", "create", "--help"],
    { env },
  );
  assert.match(result.stdout, /--model/);
  assert.match(result.stdout, /--fork/);
  assert.match(result.stdout, /Examples:/);
  assert.match(result.stdout, /--json/);
  const version = await exec(process.execPath, [cli, "--version"], { env });
  assert.equal(version.stdout, "0.1.0\n");
});

test("literal --json after the argument delimiter does not select machine output", async () => {
  await assert.rejects(
    exec(
      process.execPath,
      [cli, "send", "worker", "not-a-number", "--", "--json"],
      { env },
    ),
    (error) => {
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /Error \[invalid_argument\]/);
      assert.ok(!error.stderr.startsWith("{"));
      return true;
    },
  );
});

test("help and version support JSON with either flag order and every command accepts --json", async () => {
  for (const args of [
    ["--json", "--help"],
    ["--help", "--json"],
  ]) {
    const result = await exec(process.execPath, [cli, ...args], { env });
    const help = JSON.parse(result.stdout);
    assert.equal(help.command, "pid");
    assert.equal(help.commands.length, 12);
    assert.equal(result.stderr, "");
  }
  for (const args of [
    ["--json", "--version"],
    ["--version", "--json"],
  ])
    assert.equal(
      JSON.parse((await exec(process.execPath, [cli, ...args], { env })).stdout)
        .version,
      "0.1.0",
    );
  for (const command of [
    ["daemon", "start"],
    ["harness", "start"],
    ["harness", "list"],
    ["harness", "stop"],
    ["harness", "destroy"],
    ["conversation", "create"],
    ["conversation", "list"],
    ["send"],
    ["watch"],
    ["compact"],
    ["abort"],
    ["auth", "login"],
  ]) {
    const result = await exec(
      process.execPath,
      [cli, ...command, "--help", "--json"],
      { env },
    );
    const help = JSON.parse(result.stdout);
    assert.equal(help.command, "pid " + command.join(" "));
    assert.ok(help.options.some((option) => option.flags === "--json"));
    assert.equal(result.stderr, "");
  }
});

test("invalid arguments fail before connecting and use the requested output mode", async () => {
  for (const args of [
    ["harness", "list", "--state-dir", "/tmp/unused"],
    ["send"],
    ["conversation", "create", "worker"],
    ["conversation", "create", "worker", "--model", "p/m", "--at", "2"],
    ["send", "worker", "not-a-number", "hello"],
    ["send", "worker", "1", "hello", "--when-busy", "invalid"],
    ["conversation", "list", "worker", "--limit", "0"],
    ["harness", "create"],
    ["harness", "list", "extra"],
  ]) {
    for (const json of [false, true]) {
      await assert.rejects(
        exec(process.execPath, [cli, ...args, ...(json ? ["--json"] : [])], {
          env,
        }),
        (error) => {
          assert.equal(error.stdout, "");
          assert.equal(error.code, 1);
          if (json)
            assert.ok(
              [
                "invalid_argument",
                "model_required",
                "unknown_command",
              ].includes(JSON.parse(error.stderr).error.code),
              error.stderr,
            );
          else {
            assert.match(error.stderr, /Error/);
            assert.ok(!error.stderr.startsWith("{"));
          }
          assert.ok(!error.stderr.includes("\u001b"));
          return true;
        },
      );
    }
  }
});
