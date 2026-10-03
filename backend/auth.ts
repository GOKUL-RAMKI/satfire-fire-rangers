// Dashboard login gate (plan Phase 7: the dashboard shows live industrial-site data).
// scrypt password check with constant-time compare, HMAC-signed session cookie, login rate limit.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const COOKIE = "satfire_session";

export interface Auth {
  verifyPassword(username: string, password: string): boolean;
  issue(username: string): string;
  verify(token: string | undefined): string | null;
  allowAttempt(ip: string): boolean;
  recordFailure(ip: string): void;
  recordSuccess(ip: string): void;
  cookie(token: string, maxAgeS: number): string;
  clearCookie(): string;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function createAuth(opts: { user: string; password: string; secret: string; ttlHours: number; secure: boolean }): Auth {
  const salt = randomBytes(16);
  const hash = scryptSync(opts.password, salt, 32);
  const userHash = scryptSync(opts.user, salt, 32);
  const failures = new Map<string, { n: number; since: number }>();
  const WINDOW_MS = 10 * 60 * 1000;
  const MAX_FAILURES = 5;
  const sign = (payload: string) => createHmac("sha256", opts.secret).update(payload).digest("base64url");

  return {
    verifyPassword(username, password) {
      const okUser = timingSafeEqual(scryptSync(username, salt, 32), userHash);
      const okPass = timingSafeEqual(scryptSync(password, salt, 32), hash);
      return okUser && okPass;
    },
    issue(username) {
      const payload = b64(JSON.stringify({ u: username, exp: Date.now() + opts.ttlHours * 3600000 }));
      return `${payload}.${sign(payload)}`;
    },
    verify(token) {
      if (!token) return null;
      const [payload, sig] = token.split(".");
      if (!payload || !sig) return null;
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u: string; exp: number };
        return typeof u === "string" && typeof exp === "number" && exp > Date.now() ? u : null;
      } catch {
        return null;
      }
    },
    allowAttempt(ip) {
      const f = failures.get(ip);
      if (!f) return true;
      if (Date.now() - f.since > WINDOW_MS) {
        failures.delete(ip);
        return true;
      }
      return f.n < MAX_FAILURES;
    },
    recordFailure(ip) {
      const f = failures.get(ip);
      if (!f || Date.now() - f.since > WINDOW_MS) failures.set(ip, { n: 1, since: Date.now() });
      else f.n++;
    },
    recordSuccess(ip) {
      failures.delete(ip);
    },
    cookie(token, maxAgeS) {
      return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}${opts.secure ? "; Secure" : ""}`;
    },
    clearCookie() {
      return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${opts.secure ? "; Secure" : ""}`;
    },
  };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
