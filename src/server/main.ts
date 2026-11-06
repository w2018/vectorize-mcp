import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { hashPassword } from "./password.js";
import { buildApp } from "./app.js";
import { readServerConfig } from "./server-config.js";
const dataDir = resolve(process.env.DATA_DIR ?? "data");
const passwordFile = join(dataDir, "admin-password.json");
const serverConfigFile = join(dataDir, "server-config.json");
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
  if (password.length < 8 || password.length > 1024)
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
  // 监听 IP 与端口来自 data/server-config.json；修改后重启服务生效。
  const serverConfig = await readServerConfig(serverConfigFile);
  const host = serverConfig.host;
  const port = serverConfig.port;
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const origin = "http://" + displayHost + ":" + port;
  const { app } = await buildApp({
    databasePath: join(dataDir, "memory.sqlite"),
    passwordHash: stored.hash,
    origin,
    backupDir: join(dataDir, "backups"),
    passwordFile,
    updateRoot: process.cwd(),
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
      " — 配置文件 " +
      serverConfigFile +
      " — MCP endpoint /mcp",
  );
}
