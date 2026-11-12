import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareRuntimeDirectory,
  privateDirectory,
  validateEndpoint,
} from "../dist/paths.js";

test("endpoint validation rejects public runtime directories, substituted socket files, and symlink directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pid-paths-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(directory, "run");
  try {
    const runtime = await prepareRuntimeDirectory();
    await assert.rejects(
      validateEndpoint(),
      (error) => error.code === "daemon_unavailable",
    );
    await chmod(runtime, 0o755);
    await assert.rejects(
      validateEndpoint(),
      (error) => error.code === "unsafe_endpoint",
    );
    await chmod(runtime, 0o700);
    await writeFile(join(runtime, "daemon.sock"), "substitute", {
      mode: 0o600,
    });
    await assert.rejects(
      validateEndpoint(),
      (error) => error.code === "unsafe_endpoint",
    );
    await mkdir(join(directory, "target"));
    await symlink(join(directory, "target"), join(directory, "link"));
    await assert.rejects(
      privateDirectory(join(directory, "link")),
      (error) => error.code === "unsafe_directory",
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
