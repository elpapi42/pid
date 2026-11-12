import { readFile, writeFile } from "node:fs/promises";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { Server } from "../../packages/sdk/dist/daemon/server.js";
const [state, marker] = process.argv.slice(2);
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 50 });
models.setProvider(faux.provider);
const response = async () => {
  let count = 0;
  try {
    count = Number(await readFile(marker, "utf8"));
  } catch {}
  await writeFile(marker, String(count + 1));
  return fauxAssistantMessage(
    count ? "Recovered answer" : "Work in progress. ".repeat(300),
  );
};
faux.setResponses(Array.from({ length: 20 }, () => response));
const server = await Server.open(state, { models });
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  void server.close().catch(() => {
    process.exitCode = 1;
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
