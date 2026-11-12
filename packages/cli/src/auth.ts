import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { input, password, select } from "@inquirer/prompts";
import { PidError } from "@elpapi42/pid-sdk";
import type { AuthPrompt, Client } from "@elpapi42/pid-sdk";
import { authEvent, plain } from "./output.js";

/** Piped machine input can arrive before the daemon's first prompt. */
class Answers {
  private readonly reader = createInterface({
    input: process.stdin,
    terminal: false,
    crlfDelay: Infinity,
  });
  private lines: string[] = [];
  private bytes = 0;
  private ended = false;
  private failure?: Error;
  private waiting?: {
    resolve(value: string): void;
    reject(error: Error): void;
  };
  constructor() {
    this.reader.on("line", (value) => {
      if (this.failure) return;
      if (
        Buffer.byteLength(value) > 65536 ||
        this.lines.length >= 128 ||
        this.bytes + Buffer.byteLength(value) > 1048576
      ) {
        this.failure = new PidError(
          "input_too_large",
          "Authentication input exceeded its limit",
        );
        this.waiting?.reject(this.failure);
        this.waiting = undefined;
        this.reader.close();
        return;
      }
      if (this.waiting) {
        const waiter = this.waiting;
        this.waiting = undefined;
        waiter.resolve(value);
      } else {
        this.lines.push(value);
        this.bytes += Buffer.byteLength(value);
      }
    });
    this.reader.on("close", () => {
      this.ended = true;
      this.waiting?.reject(
        new PidError("input_closed", "Authentication input ended"),
      );
      this.waiting = undefined;
    });
  }
  async next(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    const value = this.lines.shift();
    if (value !== undefined) {
      this.bytes -= Buffer.byteLength(value);
      return value;
    }
    if (this.ended)
      throw new PidError(
        "input_closed",
        "Authentication requires newline-separated answers on stdin",
      );
    if (this.waiting)
      throw new PidError(
        "input_in_use",
        "Authentication prompts cannot share one pending input line",
      );
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.waiting = undefined;
        reject(new PidError("auth_cancelled", "Authentication input canceled"));
      };
      this.waiting = {
        resolve: (answer) => {
          signal.removeEventListener("abort", cancel);
          resolve(answer);
        },
        reject: (error) => {
          signal.removeEventListener("abort", cancel);
          reject(error);
        },
      };
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  close(): void {
    this.reader.close();
    this.lines = [];
    this.bytes = 0;
  }
}

export async function login(
  client: Client,
  provider: string,
  json: boolean,
  signal: AbortSignal,
): Promise<{ provider: string; type: string }> {
  const answers = json && !process.stdin.isTTY ? new Answers() : undefined;
  let inputFailure: unknown;
  try {
    return await client.auth.login(provider, {
      signal,
      notify(event) {
        process.stderr.write(
          (json ? JSON.stringify(event) : authEvent(event)) + "\n",
        );
      },
      async prompt(prompt: AuthPrompt) {
        const promptSignal = prompt.signal
          ? AbortSignal.any([signal, prompt.signal])
          : signal;
        try {
          promptSignal.throwIfAborted();
          const publish = () => {
            const { signal: _signal, ...wire } = prompt;
            process.stderr.write(
              JSON.stringify({ type: "auth_prompt", prompt: wire }) + "\n",
            );
          };
          if (answers) {
            publish();
            return await answers.next(promptSignal);
          }
          if (!json && (!process.stdin.isTTY || !process.stderr.isTTY)) {
            throw new PidError(
              "interactive_input_required",
              "Login needs a terminal. For automation, use --json and pipe newline-separated answers through stdin",
            );
          }
          const target = json
            ? new Writable({
                write(_chunk, _encoding, callback) {
                  callback();
                },
              })
            : process.stderr;
          const context = {
            input: process.stdin,
            output: target,
            signal: promptSignal,
          };
          const message = json ? "" : plain(prompt.message);
          try {
            if (!json && prompt.type === "select")
              return await select(
                {
                  message,
                  choices: prompt.options.map((option) => ({
                    name: plain(option.label),
                    value: option.id,
                    description: option.description
                      ? plain(option.description)
                      : undefined,
                  })),
                },
                context,
              );
            // Inquirer configures the terminal before the JSON prompt is published, so an immediate answer cannot echo a secret.
            const reading =
              prompt.type === "secret" || prompt.type === "manual_code"
                ? password({ message, mask: !json }, context)
                : input({ message }, context);
            if (json) publish();
            const answer = await reading;
            return prompt.type === "select" ? answer.trim() : answer;
          } finally {
            if (json) target.destroy();
          }
        } catch (error) {
          if (!promptSignal.aborted)
            inputFailure =
              (error as Error).name === "ExitPromptError"
                ? new PidError("auth_cancelled", "Authentication canceled")
                : error;
          throw error;
        }
      },
    });
  } catch (error) {
    throw inputFailure ?? error;
  } finally {
    answers?.close();
    process.stdin.pause();
  }
}
