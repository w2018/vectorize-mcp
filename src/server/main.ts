import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { hashPassword } from "./password.js";
import { buildApp } from "./app.js";
import {
  isLoopbackOrigin,
  readServerSettings,
  validOrigin,
} from "./server-settings.js";
const dataDir = resolve(process.env.DATA_DIR ?? "data");
const passwordFile = join(dataDir, "admin-password.json");
const serverSettingsFile = join(dataDir, "server-settings.json");
await mkdir(dataDir, { recursive: true });
if (process.argv.includes("init-admin")) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password)
    throw new Error(
      "Set ADMIN_PASSWORD (8–1024 characters) for initialization",
    );
  await writeFile(
    passwordFile,
    JSON.stringify({ hash: hashPassword(password) }),
    { flag: "wx", mode: 0o600 },
  );
  delete process.env.ADMIN_PASSWORD;
  console.log("管理员已初始化。请清除 ADMIN_PASSWORD 环境变量，然后启动服务。");
} else if (process.argv.includes("reset-admin")) {
  // 忘记密码时使用：直接覆盖写入新哈希，不需要旧密码。
  const password = process.env.ADMIN_PASSWORD;
  if (!password)
    throw new Error(
      "Set ADMIN_PASSWORD (8–1024 characters) to reset the administrator password",
    );
  if (password.length < 12 || password.length > 1024)
    throw new Error("ADMIN_PASSWORD must contain 8–1024 characters");
  const tmp = passwordFile + ".tmp";
  await writeFile(tmp, JSON.stringify({ hash: hashPassword(password) }), {
    mode: 0o600,
  });
  await rename(tmp, passwordFile);
  delete process.env.ADMIN_PASSWORD;
  console.log("管理员密码已重置。请清除 ADMIN_PASSWORD 环境变量，然后重启服务。");
} else {
  const stored = JSON.parse(await readFile(passwordFile, "utf8")) as {
    hash: string;
  };
  if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(stored.hash))
    throw new Error("Invalid administrator password file");
  const port = Number(process.env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const settings = await readServerSettings(serverSettingsFile);
  const host = process.env.HOST ?? settings.bind_host;
  if (host !== "127.0.0.1" && host !== "0.0.0.0")
    throw new Error("HOST must be 127.0.0.1 or 0.0.0.0");
  const origin =
    process.env.PUBLIC_ORIGIN ??
    settings.public_origin ??
    "http://127.0.0.1:" + port;
  if (!validOrigin(origin))
    throw new Error(
      "PUBLIC_ORIGIN must be an HTTP(S) origin without a trailing slash",
    );
  if (host === "0.0.0.0" && !isLoopbackOrigin(origin))
    throw new Error(
      "监听 0.0.0.0 对外开放时，PUBLIC_ORIGIN 必须填浏览器实际访问的地址；公网访问请使用 HTTPS 反向代理",
    );
  if (
    !origin.startsWith("https:") &&
    !isLoopbackOrigin(origin)
  )
    throw new Error(
      "Remote access requires HTTPS PUBLIC_ORIGIN behind a TLS reverse proxy",
    );
  const { app } = await buildApp({
    databasePath: join(dataDir, "memory.sqlite"),
    passwordHash: stored.hash,
    origin,
    backupDir: join(dataDir, "backups"),
    passwordFile,
    updateRoot: process.cwd(),
    serverSettings: {
      path: serverSettingsFile,
      bindHost: host,
      port,
      originOverride: process.env.PUBLIC_ORIGIN ?? null,
      hostOverride: process.env.HOST ?? null,
    },
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
  console.log(
    "Vectorize MCP listening on " +
      host +
      ":" +
      port +
      " — public origin " +
      origin +
      " — MCP endpoint /mcp",
  );
}
