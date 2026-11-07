import { Worker } from "node:worker_threads";
import { FairScheduler, CapacityError } from "./scheduler.js";
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}
class Connection {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private id = 0;
  private failed: Error | undefined;
  readonly ready: Promise<void>;
  constructor(path: string, readonlyMode: boolean) {
    const source = import.meta.url.endsWith(".ts");
    this.worker = new Worker(
      new URL(source ? "./db-worker.ts" : "./db-worker.js", import.meta.url),
      {
        workerData: { path, readonly: readonlyMode },
        ...(source ? { execArgv: ["--import", "tsx"] } : {}),
      },
    );
    this.ready = new Promise((resolve, reject) => {
      const fail = (e: Error) => {
        this.failed = e;
        reject(e);
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
      };
      this.worker.on("message", (m) => {
        if (m.ready) {
          resolve();
          return;
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error)
          p.reject(Object.assign(new Error(m.error.message), m.error));
        else p.resolve(m.value);
      });
      this.worker.on("error", fail);
      this.worker.on("exit", () =>
        fail(
          Object.assign(new Error("Database worker stopped"), {
            code: "DATABASE_UNAVAILABLE",
          }),
        ),
      );
    });
  }
  async call<T>(method: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    if (this.failed) throw this.failed;
    return new Promise<T>((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.worker.postMessage({ id, method, args });
    });
  }
  async close() {
    try {
      if (!this.failed) await this.call("close");
    } finally {
      await this.worker.terminate();
    }
  }
}
export class DatabasePool {
  private writer: Connection;
  private readers: Connection[] = [];
  private cursor = 0;
  // perKey must stay below concurrency: with (2, 128, 8, 200) the guard
  // (byKey < perKey) can never fail, so "per-account fairness" was inert.
  // Reader connections below are kept in sync with read concurrency.
  private reads = new FairScheduler(4, 256, 2, 200);
  private writes = new FairScheduler(1, 128, 1, 200);
  private maintenance = false;
  private closing = false;
  private lifecycle: Promise<unknown> | undefined;
  private closePromise: Promise<void> | undefined;
  private inflight = new Set<Promise<unknown>>();
  private constructor(private path: string) {
    this.writer = new Connection(path, false);
  }
  static async open(path: string) {
    const pool = new DatabasePool(path);
    try {
      await pool.writer.ready;
      await pool.openReaders();
      return pool;
    } catch (e) {
      await pool.close().catch(() => {});
      throw e;
    }
  }
  private async openReaders() {
    const readers = Array.from(
      { length: 4 },
      () => new Connection(this.path, true),
    );
    try {
      await Promise.all(readers.map((r) => r.ready));
      this.readers = readers;
    } catch (error) {
      await Promise.allSettled(readers.map((r) => r.close()));
      throw error;
    }
  }
  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.maintenance)
      return Promise.reject(
        new CapacityError("Database maintenance in progress"),
      );
    const p = run();
    this.inflight.add(p);
    void p.then(
      () => this.inflight.delete(p),
      () => this.inflight.delete(p),
    );
    return p;
  }
  read<T>(key: string, method: string, ...args: unknown[]): Promise<T> {
    if (this.readers.length === 0)
      return Promise.reject(
        Object.assign(new Error("Database readers unavailable"), {
          code: "DATABASE_UNAVAILABLE",
        }),
      );
    return this.track(() =>
      this.reads.run(key, () =>
        this.readers[this.cursor++ % this.readers.length]!.call<T>(
          method,
          ...args,
        ),
      ),
    );
  }
  write<T>(key: string, method: string, ...args: unknown[]): Promise<T> {
    return this.track(() =>
      this.writes.run(key, () => this.writer.call<T>(method, ...args)),
    );
  }
  get metrics() {
    return {
      reads: this.reads.stats,
      writes: this.writes.stats,
      maintenance: this.maintenance,
    };
  }
  restore<T>(path: string, ticket: string): Promise<T> {
    if (this.maintenance)
      throw new CapacityError("Database maintenance in progress");
    this.maintenance = true;
    const operation = (async () => {
      await Promise.allSettled([...this.inflight]);
      let failure: unknown;
      let result: T | undefined;
      try {
        await Promise.all(this.readers.map((r) => r.close()));
        this.readers = [];
        result = await this.writer.call<T>("restoreBackup", path, ticket);
      } catch (e) {
        failure = e;
      }
      if (!this.closing) {
        try {
          await this.openReaders();
          this.maintenance = false;
        } catch (e) {
          // The restore itself may have failed or the swapped database is
          // unreadable. Clear maintenance so callers get a truthful error
          // instead of every request reporting OVERLOADED forever.
          this.maintenance = false;
          throw new AggregateError(
            failure ? [failure, e] : [e],
            "Database unavailable after restore",
          );
        }
      }
      if (failure) throw failure;
      return result as T;
    })();
    this.lifecycle = operation;
    return operation;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.maintenance = true;
    this.closePromise = (async () => {
      await this.lifecycle?.catch(() => {});
      await Promise.allSettled([...this.inflight]);
      await Promise.allSettled(this.readers.map((r) => r.close()));
      await this.writer.close();
    })();
    return this.closePromise;
  }
}
