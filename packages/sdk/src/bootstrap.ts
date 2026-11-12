import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection } from "./client.js";
import {
  absolutePath,
  atomicWrite,
  privateDirectory,
  prepareRuntimeDirectory,
  runtimeDirectory,
  unitPath,
} from "./paths.js";
import { PidError } from "./protocol.js";
import type { DaemonInfo } from "./types.js";
const execute = promisify(execFile);
const marker = "# Managed by PID v1\n";
export function unitQuote(value: string): string {
  if (value.includes("\0"))
    throw new PidError("invalid_path", "Paths cannot contain NUL");
  return (
    '"' +
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/%/g, "%%")
      .replace(/\$/g, () => "$$") +
    '"'
  );
}
export function renderUnit(
  stateDir: string,
  node = process.execPath,
  daemon = fileURLToPath(new URL("./daemon/main.js", import.meta.url)),
): string {
  return `${marker}# StateDir: ${Buffer.from(stateDir).toString("base64url")}\n[Unit]\nDescription=PID daemon\n\n[Service]\nType=exec\nExecStart=${unitQuote(node)} ${unitQuote(daemon)} --state-dir ${unitQuote(stateDir)}\nEnvironment=${unitQuote("XDG_RUNTIME_DIR=" + dirname(runtimeDirectory()))}\nRestart=always\nRestartSec=3s\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
async function probe(): Promise<DaemonInfo | undefined> {
  const client = new Connection(700);
  try {
    return await client.open();
  } catch (error) {
    if (
      error instanceof PidError &&
      ["protocol_mismatch", "ipc_path_too_long"].includes(error.code)
    )
      throw error;
    return;
  } finally {
    await client.close();
  }
}
async function command(
  program: string,
  args: string[],
  step: string,
): Promise<string> {
  try {
    return (
      await execute(program, args, { timeout: 15000, maxBuffer: 1048576 })
    ).stdout.trim();
  } catch {
    throw new PidError("service_setup_failed", `Could not ${step}`, {
      command: [program, ...args],
    });
  }
}
export async function startDaemon(
  options: {
    stateDir?: string;
    timeoutMs?: number;
  } = {},
): Promise<DaemonInfo> {
  if (process.platform !== "linux")
    throw new PidError(
      "unsupported_platform",
      "Daemon bootstrap currently requires Linux with systemd and util-linux flock",
    );
  const directory = await prepareRuntimeDirectory();
  // Serialize persistent service changes across independent SDK clients with a kernel lifetime lock.
  const worker = fileURLToPath(new URL("./bootstrap-main.js", import.meta.url));
  try {
    const { stdout } = await execute(
      "/usr/bin/flock",
      [
        "--exclusive",
        "--no-fork",
        join(directory, "bootstrap.lock"),
        process.execPath,
        worker,
        JSON.stringify(options),
      ],
      { timeout: (options.timeoutMs ?? 60000) + 60000, maxBuffer: 1048576 },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = (
      error as {
        stderr?: string;
      }
    ).stderr;
    for (const line of stderr?.trim().split("\n").reverse() ?? []) {
      try {
        const result = JSON.parse(line);
        if (result.error?.code)
          throw new PidError(
            result.error.code,
            result.error.message,
            result.error.details,
          );
      } catch (parsed) {
        if (parsed instanceof PidError) throw parsed;
      }
    }
    throw new PidError(
      "service_setup_failed",
      "Daemon service setup could not complete",
    );
  }
}
export async function configureDaemon(
  options: {
    stateDir?: string;
    timeoutMs?: number;
  } = {},
): Promise<DaemonInfo> {
  if (process.platform !== "linux")
    throw new PidError(
      "unsupported_platform",
      "Daemon bootstrap currently requires Linux with systemd and util-linux flock",
    );
  const file = unitPath();
  let previous: string | undefined;
  try {
    previous = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous !== undefined && !previous.startsWith(marker))
    throw new PidError(
      "service_conflict",
      "pid.service exists and is not a PID-managed unit",
    );
  const saved = previous?.match(/^# StateDir: ([A-Za-z0-9_-]+)$/m)?.[1];
  const requested =
    options.stateDir ??
    (saved
      ? Buffer.from(saved, "base64url").toString()
      : join(homedir(), ".pid"));
  const stateDir = await privateDirectory(absolutePath(requested));
  await prepareRuntimeDirectory();
  const running = await probe();
  if (running && running.stateDir !== stateDir)
    throw new PidError(
      "state_dir_conflict",
      "Another state directory is already served by this user's daemon",
      { running: running.stateDir, requested: stateDir },
    );
  const content = renderUnit(stateDir);
  const changed = previous !== content;
  if (changed) {
    // Keep an interrupted apply distinguishable from a ready configuration on the next SDK call.
    await atomicWrite(
      file,
      content + "# PID configuration pending readiness\n",
    );
    await command(
      "systemctl",
      ["--user", "daemon-reload"],
      "reload the systemd user service definition",
    );
  }
  await command(
    "systemctl",
    ["--user", "enable", "--now", "pid.service"],
    "enable and start pid.service",
  );
  const uid = String(process.getuid!());
  const linger = await command(
    "loginctl",
    ["show-user", uid, "--property=Linger", "--value"],
    "check user lingering",
  );
  if (linger !== "yes") {
    await command(
      "loginctl",
      ["enable-linger", uid],
      "enable boot-before-login operation; administrator authorization may be required",
    );
    if (
      (await command(
        "loginctl",
        ["show-user", uid, "--property=Linger", "--value"],
        "verify user lingering",
      )) !== "yes"
    )
      throw new PidError(
        "linger_not_enabled",
        "Boot-before-login operation was not enabled",
      );
  }
  if (changed && running)
    await command(
      "systemctl",
      ["--user", "restart", "pid.service"],
      "restart pid.service with the updated executable configuration",
    );
  const deadline = Date.now() + (options.timeoutMs ?? 60000);
  do {
    const info = await probe();
    if (info && info.stateDir !== stateDir)
      throw new PidError(
        "state_dir_conflict",
        "Daemon started with another state directory",
      );
    if (info && !info.recovering) {
      if (info.errors.length)
        throw new PidError(
          "recovery_failed",
          "Daemon is reachable but some harnesses failed recovery",
          { errors: info.errors },
        );
      if (changed) {
        await atomicWrite(file, content);
        await command(
          "systemctl",
          ["--user", "daemon-reload"],
          "reload the completed service definition",
        );
      }
      // Do not expose internal per-client transport metadata in the bootstrap receipt.
      return {
        stateDir: info.stateDir,
        pid: info.pid,
        instanceId: info.instanceId,
        recovering: false,
        errors: [],
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new PidError(
    "daemon_not_ready",
    "The systemd unit started, but PID did not become ready",
  );
}
