import { lookup } from "node:dns/promises";
import { DomainError } from "../core/types.js";

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

function blockedIpv4(ip: string): boolean {
  const p = ip.split(".").map((x) => Number(x));
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255))
    return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // unspecified / private / loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function blockedIpv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb"))
    return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local
  if (h.startsWith("ff")) return true; // multicast
  return false;
}

function ipLike(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** Parse a user-supplied OpenAI-compatible model endpoint and reject obvious SSRF
 * targets. Loopback stays usable for local model gateways; private/link-local/
 * metadata ranges and metadata hostnames are refused. */
export async function assertModelBaseUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DomainError("VALIDATION_ERROR", "服务地址不是合法的 http(s) 地址。");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new DomainError("VALIDATION_ERROR", "服务地址只支持 http 或 https。");
  if (url.username || url.password)
    throw new DomainError("VALIDATION_ERROR", "服务地址不能包含用户名或密码。");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host)
    throw new DomainError("VALIDATION_ERROR", "服务地址缺少主机名。");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal"))
    throw new DomainError("VALIDATION_ERROR", "该服务地址指向内网或元数据主机，已拒绝。");
  if (ipLike(host)) {
    if (host.includes(":") ? blockedIpv6(host) && host !== "::1" : blockedIpv4(host) && !host.startsWith("127."))
      throw new DomainError("VALIDATION_ERROR", "该服务地址指向内网或元数据地址，已拒绝。");
    return url;
  }
  let addresses: { address: string; family: number }[] = [];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return url; // Let fetch report a normal DNS failure; no internal host was exposed.
  }
  for (const entry of addresses) {
    if (entry.family === 4 ? blockedIpv4(entry.address) && !entry.address.startsWith("127.") : blockedIpv6(entry.address) && entry.address !== "::1")
      throw new DomainError("VALIDATION_ERROR", "该服务地址解析到内网或元数据地址，已拒绝。");
  }
  return url;
}

export function sameEndpointHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}
