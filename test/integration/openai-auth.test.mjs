import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Server } from "../../packages/sdk/dist/daemon/server.js";
import { connect } from "../../packages/sdk/dist/index.js";

test(
  "native OpenAI OAuth reaches browser authorization with a stable persisted host ID",
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pid-openai-auth-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(directory, "run");
    const state = join(directory, "state");
    let server;
    let client;
    try {
      const hosts = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        server = await Server.open(state);
        client = await connect();
        const abort = new AbortController();
        let authorization;
        const login = client.auth.login("openai", {
          signal: abort.signal,
          prompt: async (prompt) =>
            prompt.type === "select" ? "oauth" : new Promise(() => {}),
          notify(event) {
            if (event.type === "auth_url") {
              authorization = new URL(event.url);
              abort.abort();
            }
          },
        });
        await assert.rejects(login, (error) => {
          assert.ok(
            authorization,
            "OpenAI login must reach the browser URL before cancellation",
          );
          return error.code === "auth_cancelled";
        });
        assert.equal(authorization.searchParams.get("agent_name_hint"), "PID");
        const host = authorization.searchParams.get("ext_agent_host_id");
        assert.match(host, /^urn:uuid:[a-f0-9-]{36}$/);
        hosts.push(host);
        await client.close();
        client = undefined;
        await server.close();
        server = undefined;
      }
      assert.equal(hosts[0], hosts[1]);
      assert.equal(
        (await stat(join(state, "auth", ".device-id"))).mode & 0o777,
        0o600,
      );
    } finally {
      await client?.close();
      await server?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
