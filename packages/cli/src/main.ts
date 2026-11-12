#!/usr/bin/env node
import { run } from "./commands.js";

const abort = new AbortController();
let brokenPipe = false;
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
process.stdout.on("error", (error) => {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") {
    brokenPipe = true;
    abort.abort();
  } else throw error;
});
process.exitCode = await run(process.argv.slice(2), abort.signal);
if (brokenPipe) process.exitCode = 0;
