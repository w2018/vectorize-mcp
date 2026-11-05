import { createClient, type WebDAVClient } from "webdav";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

export type WebdavProvider = "jianguoyun" | "custom";

export interface WebdavSettings {
  provider: WebdavProvider;
  url: string;
  username: string;
  password: string;
  root: string;
}

export interface WebdavStatus {
  configured: boolean;
  provider: WebdavProvider;
  url: string;
  username: string;
  root: string;
  has_password: boolean;
  presets: { key: WebdavProvider; label: string; url: string }[];
}

const PRESETS: { key: WebdavProvider; label: string; url: string }[] = [
  {
    key: "jianguoyun",
    label: "坚果云",
    url: "https://dav.jianguoyun.com/dav/",
  },
  { key: "custom", label: "其他 WebDAV", url: "" },
];
const DEFAULT_ROOT = "vectorize-mcp";

export const webdavPresets = () => PRESETS;

function enc(key: Buffer, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body]
    .map((part) => part.toString("base64"))
    .join(".");
}

function dec(key: Buffer, blob: string): string {
  const [iv, tag, body] = blob.split(".").map((part) => Buffer.from(part, "base64"));
  if (!iv || !tag || !body) throw new Error("BAD_SECRET");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export class WebdavCloud {
  private keyCache?: Buffer;
  constructor(
    private readonly configPath: string,
    private readonly keyPath: string,
    private readonly factory: (
      url: string,
      options: { username: string; password: string },
    ) => WebDAVClient = (url, options) => createClient(url, options),
  ) {}

  private key(): Buffer {
    if (this.keyCache) return this.keyCache;
    if (existsSync(this.keyPath)) {
      this.keyCache = Buffer.from(readFileSync(this.keyPath, "utf8").trim(), "hex");
      return this.keyCache;
    }
    const key = randomBytes(32);
    mkdirSync(dirname(this.keyPath), { recursive: true });
    writeFileSync(this.keyPath, key.toString("hex"), { mode: 0o600 });
    this.keyCache = key;
    return key;
  }

  read(): WebdavSettings | null {
    if (!existsSync(this.configPath)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf8")) as Record<
        string,
        unknown
      >;
      const url = text(raw.url, 500);
      const username = text(raw.username, 200);
      if (!url || !username) return null;
      return {
        provider: raw.provider === "custom" ? "custom" : "jianguoyun",
        url,
        username,
        password:
          typeof raw.password === "string" ? dec(this.key(), raw.password) : "",
        root: text(raw.root, 120) || DEFAULT_ROOT,
      };
    } catch {
      return null;
    }
  }

  status(): WebdavStatus {
    const current = this.read();
    return {
      configured: !!current,
      provider: current?.provider ?? "jianguoyun",
      url: current?.url ?? PRESETS[0]!.url,
      username: current?.username ?? "",
      root: current?.root ?? DEFAULT_ROOT,
      has_password: !!current?.password,
      presets: PRESETS,
    };
  }

  save(input: Record<string, unknown>): WebdavStatus {
    const previous = this.read();
    const url = text(input.url, 500) || PRESETS[0]!.url;
    const username = text(input.username, 200);
    if (!/^https?:\/\//i.test(url)) throw new Error("WEBDAV_URL_INVALID");
    if (!username) throw new Error("WEBDAV_USERNAME_REQUIRED");
    const password =
      typeof input.password === "string" && input.password.length
        ? input.password.slice(0, 500)
        : (previous?.password ?? "");
    if (!password) throw new Error("WEBDAV_PASSWORD_REQUIRED");
    const settings: WebdavSettings = {
      provider: input.provider === "custom" ? "custom" : "jianguoyun",
      url: url.endsWith("/") ? url : url + "/",
      username,
      password,
      root: (text(input.root, 120) || DEFAULT_ROOT).replace(/^\/+|\/+$/g, ""),
    };
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(
      this.configPath,
      JSON.stringify(
        {
          provider: settings.provider,
          url: settings.url,
          username: settings.username,
          password: enc(this.key(), settings.password),
          root: settings.root,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return this.status();
  }

  client(): { client: WebDAVClient; settings: WebdavSettings } {
    const settings = this.read();
    if (!settings) throw new Error("WEBDAV_NOT_CONFIGURED");
    const client = this.factory(settings.url, {
      username: settings.username,
      password: settings.password,
    });
    return { client, settings };
  }

  private remote(settings: WebdavSettings, name?: string) {
    return "/" + [settings.root, name].filter(Boolean).join("/");
  }

  async ensureRoot(): Promise<string> {
    const { client, settings } = this.client();
    const root = this.remote(settings);
    try {
      const info = (await client.stat(root)) as { type?: string } | undefined;
      if (!info || info.type === "directory") return root;
      throw new Error("WEBDAV_ROOT_CONFLICT");
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      await client.createDirectory(root, { recursive: true });
      return root;
    }
  }

  async test(): Promise<{ ok: true; root: string; latency_ms: number }> {
    const started = Date.now();
    const root = await this.ensureRoot();
    return { ok: true, root, latency_ms: Date.now() - started };
  }

  async list(): Promise<
    { name: string; size: number; modified_at: string; path: string }[]
  > {
    const { client, settings } = this.client();
    const root = await this.ensureRoot();
    const entries = (await client.getDirectoryContents(root)) as {
      basename: string;
      type: string;
      size: number;
      lastmod: string;
    }[];
    return entries
      .filter((entry) => entry.type === "file")
      .map((entry) => ({
        name: entry.basename,
        size: Number(entry.size) || 0,
        modified_at: entry.lastmod,
        path: this.remote(settings, entry.basename),
      }))
      .sort((a, b) => String(b.modified_at).localeCompare(String(a.modified_at)));
  }

  async upload(localPath: string, name: string): Promise<number> {
    const { client, settings } = this.client();
    await this.ensureRoot();
    const body = readFileSync(localPath);
    await client.putFileContents(this.remote(settings, name), body, {
      overwrite: true,
      contentLength: body.length,
    });
    return body.length;
  }

  async download(
    name: string,
    destination: string,
    progress: (done: number, total: number) => void,
  ): Promise<number> {
    const { client, settings } = this.client();
    const remote = this.remote(settings, name);
    const info = (await client.stat(remote)) as { size?: number };
    const total = Number(info.size) || 0;
    mkdirSync(dirname(destination), { recursive: true });
    const stream = client.createReadStream(remote) as NodeJS.ReadableStream;
    let done = 0;
    let lastTick = 0;
    stream.on("data", (chunk: Buffer) => {
      done += chunk.length;
      const now = Date.now();
      if (now - lastTick > 220) {
        lastTick = now;
        progress(done, total);
      }
    });
    await pipeline(stream, createWriteStream(destination));
    progress(total || done, total || done);
    return statSync(destination).size;
  }

  async remove(name: string): Promise<void> {
    const { client, settings } = this.client();
    await client.deleteFile(this.remote(settings, name));
  }
}
