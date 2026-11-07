import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 单一版本真源：安装根目录 package.json。源码 (src/server/*.ts) 与编译产物 (dist/server/*.js) 都恰好上溯两级。 */
function readVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const raw = JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as {
      version?: unknown;
    };
    return typeof raw.version === "string" && raw.version
      ? raw.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const APP_VERSION = readVersion();
