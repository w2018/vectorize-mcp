import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type BindHost = "127.0.0.1" | "0.0.0.0";

export interface ServerSettings {
  /** 监听地址：127.0.0.1 仅本机；0.0.0.0 对外开放。 */
  bind_host: BindHost;
  /** 浏览器实际访问的完整 origin（无末尾斜杠），对外开放时必填。 */
  public_origin: string | null;
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  bind_host: "127.0.0.1",
  public_origin: null,
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 校验 origin 必须是 http(s)、无路径与末尾斜杠。 */
export function validOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    ["http:", "https:"].includes(url.protocol) &&
    url.origin === value &&
    !value.endsWith("/")
  );
}

export function isLoopbackOrigin(value: string): boolean {
  try {
    return LOOPBACK.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export async function readServerSettings(file: string): Promise<ServerSettings> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { ...DEFAULT_SERVER_SETTINGS };
  }
  const record = (raw ?? {}) as Record<string, unknown>;
  const bind_host: BindHost =
    record.bind_host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
  const public_origin =
    typeof record.public_origin === "string" && record.public_origin.trim()
      ? record.public_origin.trim()
      : null;
  return { bind_host, public_origin };
}

export async function writeServerSettings(
  file: string,
  settings: ServerSettings,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
