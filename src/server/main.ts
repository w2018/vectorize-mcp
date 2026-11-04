import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { hashPassword } from "./password.js";
import { buildApp } from "./app.js";
const dataDir = resolve(process.env.DATA_DIR ?? "data");
const passwordFile = join(dataDir, "admin-password.json");
await mkdir(dataDir, { recursive: true });
if (process.argv.includes("init-admin")) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password)
    throw new Error(
      "Set ADMIN_PASSWORD (12–1024 characters) for initialization",
    );
  await writeFile(
    passwordFile,
    JSON.stringify({ hash: hashPassword(password) }),
    { flag: "wx", mode: 0o600 },
  );
  delete process.env.ADMIN_PASSWORD;
  console.log("管理员已初始化。请清除 ADMIN_PASSWORD 环境变量，然后启动服务。");
} else {
  const stored = JSON.parse(await readFile(passwordFile, "utf8")) as {
    hash: string;
  };
  if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(stored.hash))
    throw new Error("Invalid administrator password file");
  const port = Number(process.env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const host = process.env.HOST ?? "127.0.0.1";
  const origin = process.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:" + port;
  const url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
    throw new Error(
      "PUBLIC_ORIGIN must be an HTTP(S) origin without a trailing slash",
    );
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error(
      "Remote access requires HTTPS PUBLIC_ORIGIN behind a TLS reverse proxy",
    );
  const { app } = await buildApp({
    databasePath: join(dataDir, "memory.sqlite"),
    passwordHash: stored.hash,
    origin,
    backupDir: join(dataDir, "backups"),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    });
  await app.listen({ host, port });
  console.log("Vectorize MCP listening at " + origin + " — MCP endpoint /mcp");
}
