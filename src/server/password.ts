import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
export function hashPassword(password: string): string {
  if (password.length < 12 || password.length > 1024)
    throw new Error("Password must contain 8–1024 characters");
  const salt = randomBytes(16);
  return (
    salt.toString("hex") + ":" + scryptSync(password, salt, 64).toString("hex")
  );
}
export function verifyPassword(password: string, encoded: string): boolean {
  if (password.length > 1024) return false;
  try {
    const [salt, hash] = encoded.split(":");
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, "hex");
    const actual = scryptSync(password, Buffer.from(salt, "hex"), 64);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}
