import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../dist/daemon/store.js";

test("short IDs retry registry/name collisions, cwd registration is idempotent, and absent intent survives reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pid-store-"));
  const a = join(directory, "a");
  const b = join(directory, "b");
  await mkdir(a);
  await mkdir(b);
  const ids = ["worker", "k7m2qx", "k7m2qx", "worker", "000001"];
  let store;
  try {
    store = await Store.open(join(directory, "state"), () => ids.shift());
    const id = await store.start(a, "worker");
    assert.equal(id, "k7m2qx");
    assert.equal(await store.start(a), id);
    assert.equal(await store.start("worker"), id);
    const other = await store.start(b, "other");
    assert.equal(other, "000001");
    await assert.rejects(
      store.start(b, id),
      (error) => error.code === "name_conflict",
    );
    store.desire(id, "absent");
    await assert.rejects(
      store.start("worker"),
      (error) => error.code === "harness_destroying",
    );
    await store.close();
    store = await Store.open(join(directory, "state"));
    assert.equal(store.get(id).desired, "absent");
    assert.equal(store.resolve("worker"), id);
    store.remove(id);
    assert.throws(
      () => store.resolve("worker"),
      (error) => error.code === "harness_not_found",
    );
    assert.equal(store.resolve("other"), other);
    await assert.rejects(
      store.start(join(directory, "state", "harnesses")),
      (error) => error.code === "invalid_cwd",
    );
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
