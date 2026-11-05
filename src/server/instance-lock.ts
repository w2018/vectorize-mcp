import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
/**
 * Acquire an exclusive instance lock. A lock is only auto-cleared when the
 * recorded PID is provably not running; a live holder always fails closed so
 * two servers can never share one data directory.
 */
async function holderIsGone(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    const holder = JSON.parse(raw) as { pid?: unknown };
    const pid = holder.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
      return false;
    if (pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}
export async function acquireInstanceLock(
  databasePath: string,
): Promise<() => Promise<void>> {
  const path = resolve(databasePath) + ".instance-lock";
  await mkdir(dirname(path), { recursive: true });
  const identity = JSON.stringify({
    pid: process.pid,
    nonce: randomUUID(),
    created_at: new Date().toISOString(),
  });
  let file;
  for (let attempt = 0; ; attempt++) {
    try {
      file = await open(path, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && (await holderIsGone(path))) {
        process.stderr.write(
          "Clearing stale instance lock left by a stopped process: " + path + "\n",
        );
        await unlink(path).catch(() => {});
        continue;
      }
      throw new Error(
        "Database instance lock exists: stop the other server, or inspect the recorded PID before removing a stale lock: " +
          path,
      );
    }
  }
  try {
    await file.writeFile(identity);
    await file.sync();
  } finally {
    await file.close();
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if ((await readFile(path, "utf8")) !== identity)
      throw new Error("Instance lock ownership changed");
    await unlink(path);
  };
}