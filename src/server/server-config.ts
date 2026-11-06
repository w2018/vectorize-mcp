import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isIP } from "node:net";

export interface ServerConfig {
  /** 监听 IP：0.0.0.0 表示所有网卡，127.0.0.1 表示仅本机。 */
  host: string;
  port: number;
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  host: "0.0.0.0",
  port: 3100,
};

export function validateServerConfig(raw: unknown): ServerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("server-config.json 必须是 JSON 对象");
  const record = raw as Record<string, unknown>;
  const host = typeof record.host === "string" ? record.host.trim() : "";
  if (!host || isIP(host) === 0)
    throw new Error("server-config.json: host 必须是合法 IP，例如 0.0.0.0 或 127.0.0.1");
  const port = Number(record.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("server-config.json: port 必须是 1–65535 的整数");
  return { host, port };
}

export async function writeServerConfig(
  file: string,
  config: ServerConfig,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

export async function readServerConfig(file: string): Promise<ServerConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const defaults = { ...DEFAULT_SERVER_CONFIG };
    await writeServerConfig(file, defaults);
    return defaults;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("server-config.json 不是合法 JSON: " + file);
  }
  return validateServerConfig(raw);
}
