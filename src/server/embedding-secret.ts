import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 向量编码器的 API Key 保管。
 *
 * Key 不能明文进配置文件、不能回显到前端、不能写日志。这里沿用 WebDAV 的做法：
 * AES-256-GCM 加密后落 data/embedding-secret.json，密钥单独放 *.key（0600）。
 * 读取优先级：加密文件 > 环境变量 EMBEDDING_API_KEY。因此内网可以完全用界面配置，
 * 而容器化部署仍可只用环境变量。
 */
interface SecretFile {
  v?: unknown;
  blob?: unknown;
}

export type KeySource = "file" | "env" | "none";

export class EmbeddingSecret {
  private keyCache?: Buffer;
  constructor(
    private readonly configPath: string,
    private readonly keyPath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
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

  /** 从加密文件读 Key；文件不存在或不可解密时返回空串（不抛错，避免阻断启动）。 */
  private stored(): string {
    if (!existsSync(this.configPath)) return "";
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf8")) as SecretFile;
      const blob = typeof raw.blob === "string" ? raw.blob : "";
      if (!blob) return "";
      const [iv, tag, body] = blob
        .split(".")
        .map((part) => Buffer.from(part, "base64"));
      if (!iv || !tag || !body) return "";
      const decipher = createDecipheriv("aes-256-gcm", this.key(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      return "";
    }
  }

  /** 生效中的 Key 与其来源。空串表示未配置。 */
  resolve(): { apiKey: string; source: KeySource } {
    const stored = this.stored();
    if (stored) return { apiKey: stored, source: "file" };
    const fromEnv = (this.env.EMBEDDING_API_KEY ?? "").trim();
    if (fromEnv) return { apiKey: fromEnv, source: "env" };
    return { apiKey: "", source: "none" };
  }

  /** 只暴露“有没有”，绝不回显内容。 */
  status(): { has_key: boolean; source: KeySource } {
    const { apiKey, source } = this.resolve();
    return { has_key: Boolean(apiKey), source };
  }

  /** 保存界面输入的 Key；传空串等于清除。 */
  save(apiKey: string): void {
    const value = apiKey.trim();
    if (!value) {
      this.clear();
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const blob = [iv, cipher.getAuthTag(), body]
      .map((part) => part.toString("base64"))
      .join(".");
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify({ v: 1, blob }), { mode: 0o600 });
  }

  clear(): void {
    if (existsSync(this.configPath)) unlinkSync(this.configPath);
  }
}

export const embeddingSecretPaths = (dataDir: string) => ({
  configPath: join(dataDir, "embedding-secret.json"),
  keyPath: join(dataDir, "embedding-secret.key"),
});
