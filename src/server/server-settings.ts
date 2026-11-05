import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type BindHost = "127.0.0.1" | "0.0.0.0";

export interface ServerSettings {
  /** 监听地址：127.0.0.1 仅本机；0.0.0.0 对外开放（局域网可访问）。 */
  bind_host: BindHost;
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  bind_host: "127.0.0.1",
};

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
  return { bind_host };
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
