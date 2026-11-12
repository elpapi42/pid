import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { atomicWrite, privateDirectory } from "../paths.js";
import { PidError } from "../protocol.js";
/** One daemon owns this store. Provider refresh and login share the same queue. */
export class Credentials implements CredentialStore {
  private tails = new Map<string, Promise<unknown>>();
  private constructor(private readonly directory: string) {}
  static async open(directory: string): Promise<Credentials> {
    return new Credentials(await privateDirectory(directory));
  }
  deviceId(): Promise<string> {
    return this.serial("pid:device-id", async () => {
      const file = join(this.directory, ".device-id");
      let value: string;
      try {
        value = (await readFile(file, "utf8")).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        value = randomUUID();
        await atomicWrite(file, value + "\n");
      }
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          value,
        )
      ) {
        throw new PidError(
          "invalid_device_id",
          "The saved provider-login device ID is invalid",
        );
      }
      return value;
    });
  }
  private path(provider: string): string {
    return join(
      this.directory,
      createHash("sha256").update(provider).digest("hex") + ".json",
    );
  }
  async read(provider: string): Promise<Credential | undefined> {
    try {
      return JSON.parse(await readFile(this.path(provider), "utf8"))
        .credential as Credential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  async list(): Promise<
    {
      providerId: string;
      type: Credential["type"];
    }[]
  > {
    const result: {
      providerId: string;
      type: Credential["type"];
    }[] = [];
    for (const file of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const value = JSON.parse(
        await readFile(join(this.directory, file), "utf8"),
      );
      result.push({ providerId: value.provider, type: value.credential.type });
    }
    return result;
  }
  private async serial<T>(
    provider: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const tail = (this.tails.get(provider) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        signal?.throwIfAborted();
        return action();
      });
    this.tails.set(provider, tail);
    try {
      return await tail;
    } finally {
      if (this.tails.get(provider) === tail) this.tails.delete(provider);
    }
  }
  modify(
    provider: string,
    fn: (value: Credential | undefined) => Promise<Credential | undefined>,
    options?: {
      signal?: AbortSignal;
    },
  ): Promise<Credential | undefined> {
    return this.serial(
      provider,
      async () => {
        const current = await this.read(provider);
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next !== undefined)
          await atomicWrite(
            this.path(provider),
            JSON.stringify({ provider, credential: next }),
          );
        return next ?? current;
      },
      options?.signal,
    );
  }
  async delete(provider: string): Promise<void> {
    await this.serial(provider, async () => {
      const { rm } = await import("node:fs/promises");
      await rm(this.path(provider), { force: true });
    });
  }
}
