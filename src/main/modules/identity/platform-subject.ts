import { createHash } from "node:crypto";

/** Call only with the in-memory canonical token after Desktop SSO validation completed. */
export function desktopPlatformSubject(authenticated: boolean, verifiedAccessToken: string | null | undefined): string {
  if (!authenticated) return "";
  const parts = verifiedAccessToken?.split(".");
  if (parts?.length !== 3 || !parts.every(Boolean)) throw new Error("Verified Desktop identity is unavailable");
  let claims: { iss?: unknown; sub?: unknown };
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
  catch { throw new Error("Verified Desktop identity is unavailable"); }
  if (!claims || typeof claims.iss !== "string" || !claims.iss.trim() || typeof claims.sub !== "string" || !claims.sub.trim()) {
    throw new Error("Verified Desktop identity is unavailable");
  }
  return `desktop-user:${createHash("sha256").update(JSON.stringify([claims.iss, claims.sub])).digest("hex")}`;
}
