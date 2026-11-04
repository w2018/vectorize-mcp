import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
/** Fail closed on a stale lock: operators inspect the recorded PID before removing it. */
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
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Database instance lock exists: stop the other server, or inspect the recorded PID before removing a stale lock: " +
          path,
      );
    throw error;
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
