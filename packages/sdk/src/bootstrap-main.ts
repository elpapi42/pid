import { configureDaemon } from "./bootstrap.js";
import { errorInfo } from "./protocol.js";
try {
  process.stdout.write(
    JSON.stringify(await configureDaemon(JSON.parse(process.argv[2] ?? "{}"))) +
      "\n",
  );
} catch (error) {
  process.stderr.write(JSON.stringify({ error: errorInfo(error) }) + "\n");
  process.exitCode = 1;
}
