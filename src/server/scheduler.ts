export class CapacityError extends Error {
  readonly code = "OVERLOADED";
  readonly retryable = true;
}
type Entry<T> = {
  key: string;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
/** Bounded, per-account round-robin admission. No database work on the HTTP loop. */
export class FairScheduler {
  private queue: Entry<unknown>[] = [];
  private active = 0;
  private byKey = new Map<string, number>();
  private last = "";
  constructor(
    private concurrency = 8,
    private maxQueue = 128,
    private perKey = 8,
    private waitMs = 200,
  ) {}
  run<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(new CapacityError("Server is busy; retry later"));
    return new Promise<T>((resolve, reject) => {
      const entry = {
        key,
        run,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry as Entry<unknown>);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(new CapacityError("Queue deadline exceeded"));
          }
        }, this.waitMs),
      };
      this.queue.push(entry as Entry<unknown>);
      this.drain();
    });
  }
  private drain() {
    while (this.active < this.concurrency) {
      let i = this.queue.findIndex(
        (e) =>
          e.key !== this.last && (this.byKey.get(e.key) ?? 0) < this.perKey,
      );
      if (i < 0)
        i = this.queue.findIndex(
          (e) => (this.byKey.get(e.key) ?? 0) < this.perKey,
        );
      if (i < 0) return;
      const e = this.queue.splice(i, 1)[0]!;
      clearTimeout(e.timer);
      this.last = e.key;
      this.active++;
      this.byKey.set(e.key, (this.byKey.get(e.key) ?? 0) + 1);
      Promise.resolve()
        .then(e.run)
        .then(e.resolve, e.reject)
        .finally(() => {
          this.active--;
          this.byKey.set(e.key, (this.byKey.get(e.key) ?? 1) - 1);
          this.drain();
        });
    }
  }
  get stats() {
    return { active: this.active, queued: this.queue.length };
  }
}
