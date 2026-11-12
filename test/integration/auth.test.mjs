import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Credentials } from "../../packages/sdk/dist/daemon/auth.js";
import { Server } from "../../packages/sdk/dist/daemon/server.js";
import { connect } from "../../packages/sdk/dist/index.js";

test(
  "TTY authentication supports Inquirer human prompts and clean structured JSON without leaking secrets",
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pid-tty-auth-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    const credentials = await Credentials.open(
      join(directory, "state", "auth"),
    );
    const models = createModels({ credentials });
    const faux = fauxProvider();
    let callback = false;
    models.setProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          ...faux.provider.auth.apiKey,
          login: async () => assert.fail("Expected OAuth selection"),
        },
        oauth: {
          name: "Test OAuth",
          async login(interaction, options) {
            assert.match(options.getDeviceId(), /^[a-f0-9-]{36}$/);
            assert.equal(options.agentName, "PID");
            if (callback) {
              const browser = new AbortController();
              const pending = interaction.prompt({
                type: "manual_code",
                message: "Browser callback",
                signal: browser.signal,
              });
              const canceled = assert.rejects(pending);
              await new Promise((resolve) => setTimeout(resolve, 200));
              browser.abort();
              await canceled;
            } else {
              assert.equal(
                await interaction.prompt({ type: "text", message: "Name" }),
                "visible name",
              );
              assert.equal(
                await interaction.prompt({
                  type: "secret",
                  message: "Password",
                }),
                "pty-synthetic-secret",
              );
            }
            return {
              type: "oauth",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: Date.now() + 3600000,
            };
          },
          async refresh(credential) {
            return credential;
          },
          async toAuth(credential) {
            return { apiKey: credential.access };
          },
        },
      },
    });
    let server;
    try {
      server = await Server.open(join(directory, "state"), { models });
      const fixture = new URL("../fixtures/tty-auth.py", import.meta.url)
        .pathname;
      const cli = new URL("../../packages/cli/dist/main.js", import.meta.url)
        .pathname;
      for (const mode of ["human", "json", "cancel", "callback"]) {
        callback = mode === "callback";
        const result = await promisify(execFile)(
          "python3",
          [fixture, process.execPath, cli, mode],
          { env: process.env, timeout: 12000 },
        );
        assert.equal(JSON.parse(result.stdout).passed, true);
      }
      callback = false;
      const piped = spawn(
        process.execPath,
        [cli, "auth", "login", "faux", "--json"],
        { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
      );
      let pipedOutput = "";
      let pipedError = "";
      piped.stdout.on("data", (chunk) => {
        pipedOutput += chunk;
      });
      piped.stderr.on("data", (chunk) => {
        pipedError += chunk;
      });
      piped.stdin.end("oauth\nvisible name\npty-synthetic-secret\n");
      assert.equal((await once(piped, "exit"))[0], 0, pipedError);
      assert.equal(JSON.parse(pipedOutput).type, "oauth");
      assert.ok(!pipedError.includes("pty-synthetic-secret"));
    } finally {
      await server?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "provider-owned authentication, secret-safe JSON CLI, cancellation and serialized persistent credentials",
  { timeout: 20000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pid-auth-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    const credentials = await Credentials.open(
      join(directory, "state", "auth"),
    );
    const models = createModels({ credentials });
    const faux = fauxProvider();
    let fail = false;
    models.setProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Test authentication",
          resolve: async ({ credential }) =>
            credential ? { auth: { apiKey: credential.key } } : undefined,
          login: async (interaction) => {
            const key = await interaction.prompt({
              type: "secret",
              message: "API key",
              signal: interaction.signal,
            });
            if (fail) throw new Error("Provider echoed " + key);
            return { type: "api_key", key };
          },
        },
      },
    });
    let server;
    let client;
    try {
      server = await Server.open(join(directory, "state"), { models });
      client = await connect();
      const result = await client.auth.login("faux", {
        prompt: async (prompt) => {
          assert.equal(prompt.type, "secret");
          return "sdk-synthetic-secret";
        },
        notify() {},
      });
      assert.deepEqual(result, { provider: "faux", type: "api_key" });
      assert.equal(
        (await credentials.read("faux")).key,
        "sdk-synthetic-secret",
      );
      assert.equal(
        (await stat(join(directory, "state", "auth"))).mode & 0o777,
        0o700,
      );
      const file = (await readdir(join(directory, "state", "auth"))).find(
        (value) => value.endsWith(".json"),
      );
      assert.equal(
        (await stat(join(directory, "state", "auth", file))).mode & 0o777,
        0o600,
      );
      const cli = new URL("../../packages/cli/dist/main.js", import.meta.url)
        .pathname;
      const child = spawn(
        process.execPath,
        [cli, "--json", "auth", "login", "faux"],
        {
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => (stdout += data));
      child.stderr.on("data", (data) => (stderr += data));
      child.stdin.end("cli-synthetic-secret\n");
      const [code] = await once(child, "exit");
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), {
        provider: "faux",
        type: "api_key",
      });
      assert.ok(
        stderr
          .trim()
          .split("\n")
          .every((line) => JSON.parse(line)),
      );
      assert.ok(
        !stdout.includes("synthetic-secret") &&
          !stderr.includes("synthetic-secret"),
      );
      assert.equal(
        (await credentials.read("faux")).key,
        "cli-synthetic-secret",
      );
      for (const json of [false, true]) {
        const noInput = spawn(
          process.execPath,
          [cli, "auth", "login", "faux", ...(json ? ["--json"] : [])],
          { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
        );
        let noOutput = "";
        let diagnostic = "";
        noInput.stdout.on("data", (chunk) => {
          noOutput += chunk;
        });
        noInput.stderr.on("data", (chunk) => {
          diagnostic += chunk;
        });
        noInput.stdin.end();
        assert.equal((await once(noInput, "exit"))[0], 1);
        assert.equal(noOutput, "");
        if (json)
          assert.equal(
            JSON.parse(diagnostic.trim().split("\n").at(-1)).error.code,
            "input_closed",
          );
        else assert.match(diagnostic, /needs a terminal.*--json/);
      }
      const abort = new AbortController();
      let prompted;
      const promptReady = new Promise((resolve) => (prompted = resolve));
      const cancelling = client.auth.login("faux", {
        signal: abort.signal,
        prompt: async () => {
          prompted();
          return new Promise(() => {});
        },
        notify() {},
      });
      const cancelled = assert.rejects(
        cancelling,
        (error) => error.code === "auth_cancelled",
      );
      await promptReady;
      assert.deepEqual(await client.harnesses.list(), []);
      abort.abort();
      await cancelled;
      fail = true;
      await assert.rejects(
        client.auth.login("faux", {
          prompt: async () => "must-never-leak",
          notify() {},
        }),
        (error) =>
          error.code === "auth_failed" &&
          !JSON.stringify(error.toJSON()).includes("must-never-leak"),
      );
      await credentials.modify("counter", async () => ({
        type: "api_key",
        key: "0",
      }));
      await Promise.all(
        Array.from({ length: 10 }, () =>
          credentials.modify("counter", async (current) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return { type: "api_key", key: String(Number(current.key) + 1) };
          }),
        ),
      );
      assert.equal((await credentials.read("counter")).key, "10");
    } finally {
      await client?.close();
      await server?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
