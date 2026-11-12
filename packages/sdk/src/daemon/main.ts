import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { prepareRuntimeDirectory } from "../paths.js";
import { errorInfo, PidError, textField } from "../protocol.js";
try {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      "lock-held": { type: "boolean" },
    },
    strict: true,
  });
  const stateDir = textField(values["state-dir"], "state-dir", 4096);
  if (process.platform !== "linux" || !process.execve)
    throw new PidError(
      "unsupported_platform",
      "PID currently requires Linux, Node >=22.19, and util-linux flock",
    );
  if (!values["lock-held"]) {
    const directory = await prepareRuntimeDirectory();
    // execve + flock --no-fork preserves the daemon PID and holds the kernel lock for its entire life.
    // The private re-entry flag is not a client operation or an authentication boundary against the same UID.
    process.execve(
      "/usr/bin/flock",
      [
        "flock",
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        "73",
        "--no-fork",
        join(directory, "daemon.lock"),
        process.execPath,
        fileURLToPath(import.meta.url),
        "--lock-held",
        "--state-dir",
        stateDir,
      ],
      process.env,
    );
  } else {
    process.umask(0o077);
    const { Server } = await import("./server.js");
    const server = await Server.open(stateDir);
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      void server.close().catch((error) => {
        process.stderr.write(
          JSON.stringify({ error: errorInfo(error) }) + "\n",
        );
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: errorInfo(error) }) + "\n");
  process.exitCode = 1;
}
