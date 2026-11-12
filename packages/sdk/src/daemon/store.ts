import { randomInt } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { open } from "lmdb";
import type { Database, RootDatabase } from "lmdb";
import type { DesiredState, HarnessSpec } from "../types.js";
import { PidError, textField } from "../protocol.js";
import { absolutePath, inside, privateDirectory } from "../paths.js";
export class Store {
  private readonly root: RootDatabase;
  private readonly records: Database<HarnessSpec, string>;
  private readonly names = new Map<string, string>();
  private readonly directories = new Map<string, string>();
  private constructor(
    readonly stateDir: string,
    private readonly generateId: () => string,
  ) {
    this.root = open({ path: stateDir, maxDbs: 1, encoding: "json" });
    const version = this.root.get("schemaVersion");
    if (version !== undefined && version !== 1) {
      void this.root.close();
      throw new PidError("schema_mismatch", "Unsupported PID registry schema");
    }
    this.root.putSync("schemaVersion", 1);
    this.records = this.root.openDB<HarnessSpec, string>("harnesses", {
      encoding: "json",
    });
    for (const { key, value } of this.records.getRange()) {
      if (!/^[a-z0-9]{6}$/.test(key))
        throw new PidError(
          "invalid_registry",
          "Registry contains an invalid harness ID",
        );
      this.index(key, value);
    }
  }
  static async open(
    stateDir: string,
    generateId = () =>
      randomInt(36 ** 6)
        .toString(36)
        .padStart(6, "0"),
  ): Promise<Store> {
    const path = await privateDirectory(absolutePath(stateDir));
    await privateDirectory(join(path, "harnesses"));
    return new Store(path, generateId);
  }
  private index(id: string, spec: HarnessSpec): void {
    if (spec.name) this.names.set(spec.name, id);
    this.directories.set(spec.cwd, id);
  }
  list(): {
    id: string;
    spec: HarnessSpec;
  }[] {
    return [...this.records.getRange()].map(({ key, value }) => ({
      id: key,
      spec: value,
    }));
  }
  get(id: string): HarnessSpec | undefined {
    return this.records.get(id);
  }
  resolve(ref: string): string {
    textField(ref, "harness reference", 4096);
    const id = this.records.get(ref) ? ref : this.names.get(ref);
    if (!id)
      throw new PidError("harness_not_found", `Harness ${ref} does not exist`);
    return id;
  }
  async start(ref: string, name?: string, baseDir?: string): Promise<string> {
    textField(ref, "harness reference", 4096);
    if (name !== undefined) {
      textField(name, "name", 128);
      if (name.includes("/") || name.includes("\\"))
        throw new PidError(
          "invalid_name",
          "A harness name cannot contain path separators",
        );
    }
    let id: string | undefined;
    try {
      id = this.resolve(ref);
    } catch {
      /* A new directory can be registered. */
    }
    if (id) {
      const spec = this.get(id)!;
      if (name !== undefined && name !== spec.name)
        throw new PidError(
          "name_conflict",
          "An existing harness cannot be renamed by start",
        );
      this.desire(id, "running");
      return id;
    }
    let cwd: string;
    try {
      cwd = await realpath(absolutePath(ref, baseDir));
      if (!(await stat(cwd)).isDirectory()) throw new Error();
    } catch {
      throw new PidError(
        "harness_not_found",
        "The harness reference is unknown and is not a working directory",
      );
    }
    if (inside(join(this.stateDir, "harnesses"), cwd))
      throw new PidError(
        "invalid_cwd",
        "Working directories cannot be inside PID-managed execution storage",
      );
    // Directory resolution is async. Recheck indexes after it to serialize concurrent registrations.
    const existing = this.directories.get(cwd);
    if (existing) {
      const spec = this.get(existing)!;
      if (name !== undefined && name !== spec.name)
        throw new PidError(
          "name_conflict",
          "That directory is already registered under another name",
        );
      this.desire(existing, "running");
      return existing;
    }
    if (name && (this.names.has(name) || this.records.get(name)))
      throw new PidError("name_conflict", "Harness name is already used");
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = this.generateId();
      if (!/^[a-z0-9]{6}$/.test(candidate))
        throw new PidError(
          "invalid_id",
          "Harness IDs must contain six lowercase letters or digits",
        );
      if (
        this.records.get(candidate) ||
        this.names.has(candidate) ||
        candidate === name
      )
        continue;
      const spec: HarnessSpec = {
        cwd,
        ...(name ? { name } : {}),
        desired: "running",
      };
      this.root.transactionSync(() => {
        this.records.putSync(candidate, spec);
      });
      this.index(candidate, spec);
      return candidate;
    }
    throw new PidError(
      "id_exhausted",
      "Could not allocate a unique harness ID",
    );
  }
  desire(id: string, desired: DesiredState): void {
    const record = this.get(id);
    if (!record)
      throw new PidError("harness_not_found", "Harness does not exist");
    if (record.desired === "absent" && desired !== "absent")
      throw new PidError("harness_destroying", "Harness deletion is pending");
    this.root.transactionSync(() =>
      this.records.putSync(id, { ...record, desired }),
    );
  }
  remove(id: string): void {
    const spec = this.get(id);
    if (!spec) return;
    if (spec.desired !== "absent")
      throw new PidError(
        "invalid_state",
        "Only absent harnesses can be removed",
      );
    this.root.transactionSync(() => this.records.removeSync(id));
    if (spec.name) this.names.delete(spec.name);
    this.directories.delete(spec.cwd);
  }
  async close(): Promise<void> {
    await this.root.close();
  }
}
