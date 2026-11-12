import { chmod, lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PidError } from "./protocol.js";
export function runtimeDirectory(): string {
  return join(
    process.env.XDG_RUNTIME_DIR ||
      join(tmpdir(), `pid-${process.getuid?.() ?? "user"}`),
    "pid",
  );
}
export function endpoint(): string {
  const socket = join(runtimeDirectory(), "daemon.sock");
  if (Buffer.byteLength(socket) > 103)
    throw new PidError(
      "ipc_path_too_long",
      "The per-user runtime directory is too long for Unix IPC",
    );
  return `ipc://${socket}`;
}
export function unitPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "systemd",
    "user",
    "pid.service",
  );
}
export function absolutePath(path: string, base = process.cwd()): string {
  return resolve(
    base,
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : path,
  );
}
export async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.()
  )
    throw new PidError(
      "unsafe_directory",
      "PID requires a private directory owned by the current user",
    );
  await chmod(path, 0o700);
  return realpath(path);
}
export async function prepareRuntimeDirectory(): Promise<string> {
  await privateDirectory(dirname(runtimeDirectory()));
  return privateDirectory(runtimeDirectory());
}
export async function validateEndpoint(): Promise<void> {
  const directory = runtimeDirectory();
  try {
    for (const path of [dirname(directory), directory]) {
      const value = await lstat(path);
      if (
        !value.isDirectory() ||
        value.isSymbolicLink() ||
        value.uid !== process.getuid?.() ||
        (value.mode & 0o077) !== 0
      )
        throw new PidError(
          "unsafe_endpoint",
          "PID runtime directories must be private and owned by the current user",
        );
    }
    const socket = await lstat(endpoint().slice(6));
    if (
      !socket.isSocket() ||
      socket.uid !== process.getuid?.() ||
      (socket.mode & 0o077) !== 0
    )
      throw new PidError(
        "unsafe_endpoint",
        "PID socket must be private and owned by the current user",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new PidError(
        "daemon_unavailable",
        "The daemon endpoint does not exist",
      );
    throw error;
  }
}
export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    const { unlink } = await import("node:fs/promises");
    await unlink(temporary).catch(() => {});
  }
}
export function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}
