import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import type {
  Activity,
  DesiredState,
  ErrorInfo,
  HarnessInfo,
} from "../types.js";
import { errorInfo, PidError } from "../protocol.js";
import { Activities } from "./activities.js";
import { Runtime } from "./harness.js";
import { Store } from "./store.js";
type State = {
  actual: HarnessInfo["actual"];
  runtime?: Runtime;
  error?: ErrorInfo;
  tail: Promise<unknown>;
  reconciling?: Promise<void>;
  retryAt: number;
  failures: number;
  failed: boolean;
};
export class Reconciler {
  private readonly states = new Map<string, State>();
  private closing = false;
  private readonly timer: NodeJS.Timeout;
  recovering = true;
  constructor(
    readonly store: Store,
    private readonly models: HarnessOptions["models"],
    private readonly emit: (id: string, activity: Activity) => void,
    private readonly endStreams: (id: string, error: ErrorInfo) => void,
  ) {
    this.timer = setInterval(() => {
      for (const { id, spec } of store.list()) {
        const state = this.state(id);
        if (
          !this.closing &&
          Date.now() >= state.retryAt &&
          (state.error || spec.desired !== state.actual)
        )
          void this.run(id).catch(() => {});
      }
    }, 500);
    this.timer.unref();
  }
  private state(id: string): State {
    let value = this.states.get(id);
    if (!value) {
      value = {
        actual: "stopped",
        tail: Promise.resolve(),
        retryAt: 0,
        failures: 0,
        failed: false,
      };
      this.states.set(id, value);
    }
    return value;
  }
  list(): HarnessInfo[] {
    return this.store.list().map(({ id, spec }) => ({
      id,
      ...spec,
      actual: this.state(id).actual,
      ...(this.state(id).error ? { error: this.state(id).error } : {}),
    }));
  }
  info(id: string): HarnessInfo {
    const spec = this.store.get(id);
    if (!spec) return { id, cwd: "", desired: "absent", actual: "absent" };
    const state = this.state(id);
    return {
      id,
      ...spec,
      actual: state.actual,
      ...(state.error ? { error: state.error } : {}),
    };
  }
  async recover(): Promise<void> {
    await Promise.all(
      this.store.list().map(({ id }) => this.run(id).catch(() => {})),
    );
    this.recovering = false;
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const state = this.state(id);
    const work = state.tail.catch(() => {}).then(fn);
    state.tail = work;
    return work;
  }
  async converge(id: string, target: DesiredState): Promise<HarnessInfo> {
    await this.run(id);
    const info = this.info(id);
    if (info.desired !== target)
      throw new PidError(
        "superseded",
        "A newer lifecycle request changed the desired state",
        { id },
      );
    return info;
  }
  private async closeRuntime(id: string, state: State): Promise<void> {
    const runtime = state.runtime;
    if (!runtime) return;
    this.endStreams(id, {
      code: "harness_stopped",
      message: "Harness closed; subscribe again after it starts",
    });
    await runtime.close();
    state.runtime = undefined;
  }
  run(id: string): Promise<void> {
    const current = this.state(id);
    if (current.reconciling) return current.reconciling;
    const work = this.serial(id, async () => {
      if (this.closing) return;
      const state = this.state(id);
      try {
        for (;;) {
          const spec = this.store.get(id);
          if (!spec) return;
          if (spec.desired === "running") {
            if (state.failed) {
              await this.closeRuntime(id, state);
              state.failed = false;
            }
            if (state.runtime) {
              state.actual = "running";
              state.error = undefined;
              return;
            }
            state.actual = "starting";
            const directory = join(this.store.stateDir, "harnesses", id);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const activities = new Activities(
              (activity) => this.emit(id, activity),
              () =>
                this.endStreams(id, {
                  code: "activity_overflow",
                  message: "Native activity processing exceeded its bound",
                }),
            );
            let runtime: Runtime | undefined;
            runtime = await Runtime.open(
              join(directory, "session.sqlite"),
              spec,
              this.models,
              {
                activities,
                failed: (error) => {
                  if (!runtime || state.runtime !== runtime) return;
                  state.failed = true;
                  state.error = errorInfo(error);
                  state.actual = "error";
                  this.endStreams(id, {
                    code: "storage_failed",
                    message: "Harness storage failed",
                  });
                },
              },
            );
            state.runtime = runtime;
            if (this.closing || this.store.get(id)?.desired !== "running") {
              await this.closeRuntime(id, state);
              if (this.closing) return;
              continue;
            }
            runtime.resume();
            state.actual = "running";
            state.error = undefined;
            state.failures = 0;
            state.retryAt = 0;
            return;
          }
          state.actual = spec.desired === "absent" ? "destroying" : "stopping";
          await this.closeRuntime(id, state);
          if (this.store.get(id)?.desired !== spec.desired) continue;
          if (spec.desired === "absent") {
            await rm(join(this.store.stateDir, "harnesses", id), {
              recursive: true,
              force: true,
            });
            this.store.remove(id);
            state.actual = "absent";
            this.states.delete(id);
          } else {
            state.actual = "stopped";
            state.error = undefined;
            state.failures = 0;
          }
          return;
        }
      } catch (error) {
        // Retain ownership until close succeeds before opening or deleting native storage.
        if (state.runtime) state.failed = true;
        state.error = errorInfo(error);
        state.actual = "error";
        state.retryAt =
          Date.now() +
          Math.min(30000, 500 * 2 ** Math.min(state.failures++, 6));
        throw new PidError("reconcile_failed", state.error.message, {
          id,
          desired: this.store.get(id)?.desired,
          cause: state.error.code,
        });
      }
    });
    current.reconciling = work;
    void work
      .finally(() => {
        if (current.reconciling === work) current.reconciling = undefined;
      })
      .catch(() => {});
    return work;
  }
  runtime(ref: string): Runtime {
    const id = this.store.resolve(ref);
    const spec = this.store.get(id)!;
    const state = this.state(id);
    if (spec.desired !== "running")
      throw new PidError(
        spec.desired === "absent" ? "harness_destroying" : "harness_stopped",
        "Harness is not declared running",
      );
    if (!state.runtime || state.actual !== "running")
      throw new PidError("harness_unavailable", "Harness is not ready", {
        id,
        error: state.error,
      });
    return state.runtime;
  }
  async conversations(
    ref: string,
    limit?: number,
    cursor?: string,
  ): Promise<import("../types.js").ConversationPage> {
    const id = this.store.resolve(ref);
    return this.serial(id, async () => {
      const spec = this.store.get(id);
      if (!spec || spec.desired === "absent")
        throw new PidError("harness_destroying", "Harness deletion is pending");
      const running = this.state(id).runtime;
      if (running) return running.list(limit, cursor);
      const file = join(this.store.stateDir, "harnesses", id, "session.sqlite");
      try {
        await stat(file);
      } catch {
        throw new PidError(
          "storage_unavailable",
          "Harness database is missing",
        );
      }
      const reader = await Runtime.open(file, spec, this.models, {
        readOnly: true,
      });
      try {
        return await reader.list(limit, cursor);
      } finally {
        await reader.close();
      }
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.all(
      [...this.states.entries()].map(([id, state]) =>
        this.serial(id, () => this.closeRuntime(id, state)),
      ),
    );
  }
}
