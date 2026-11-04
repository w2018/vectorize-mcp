import { parentPort, workerData } from "node:worker_threads";
import { Store } from "../core/store.js";
const store = new Store(workerData.path, {
  readonly: workerData.readonly,
  logPath: workerData.logPath,
});
parentPort!.postMessage({ ready: true });
let chain = Promise.resolve();
parentPort!.on(
  "message",
  (message: { id: number; method: string; args: unknown[] }) => {
    chain = chain.then(async () => {
      try {
        const methods = store as unknown as Record<string, unknown>;
        const fn = methods[message.method];
        if (
          typeof fn !== "function" ||
          message.method.startsWith("_") ||
          [
            "constructor",
            "open",
            "row",
            "rows",
            "tx",
            "save",
            "load",
            "all",
            "consume",
            "preview",
            "authorize",
            "mutate",
            "replay",
          ].includes(message.method)
        )
          throw new Error("Unsupported database operation");
        const value = await fn.apply(store, message.args);
        parentPort!.postMessage({ id: message.id, value });
      } catch (e) {
        const err = e as Error & { code?: string; retryable?: boolean };
        parentPort!.postMessage({
          id: message.id,
          error: {
            code: err.code ?? "INTERNAL_ERROR",
            message: err.code ?? "Database operation failed",
            retryable: err.retryable ?? false,
          },
        });
      }
    });
  },
);
