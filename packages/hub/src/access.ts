import { createPublicKey, verify, type KeyObject } from "node:crypto";

// Cloudflare Access puts a signed JWT in the Cf-Access-Jwt-Assertion header of every request it lets through. In
// production the hub does not trust the tunnel alone: it checks the signature against the team's published keys and
// the issuer, audience, time window and (when configured) the email, so a request that reaches the hub some other way
// than through Access is refused.

export interface AccessConfig {
  /** The public host name the tunnel serves, matched exactly against the Host header. */
  host: string;
  /** The Access team domain, such as team.cloudflareaccess.com. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
  /** When set, the JWT's email must be one of these (case-insensitive). The Access policy already says who may sign in. */
  allowedEmails?: string[];
  /**
   * Client ids of Access service tokens (the tray apps) that may sign in. Access gives such a token a JWT with a
   * common_name and no email, and the hub scopes it to the tray and the control actions (see serviceTokenMayReach).
   */
  allowedServiceTokens?: string[];
}

export interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  [k: string]: unknown;
}

export type KeySource = (force: boolean) => Promise<Jwk[]>;

export interface AccessClaims {
  email: string;
  /** The service token's client id when the request came from one; such a request has no email. */
  serviceToken?: string;
  sub: string;
  exp: number;
}

const SKEW_SECONDS = 60;
const b64 = (s: string): Buffer => Buffer.from(s, "base64url");

function parsePart(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(b64(part).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Fetch and cache the team's signing keys. A miss on an unknown kid forces one refresh, at most once a minute. */
export function certsKeySource(teamDomain: string, fetcher: (url: string) => Promise<{ status: number; json(): Promise<unknown> }> = (u) => fetch(u, { signal: AbortSignal.timeout(10_000) })): KeySource {
  let keys: Jwk[] = [];
  let fetchedAt = 0;
  return async (force) => {
    const age = Date.now() - fetchedAt;
    if (keys.length > 0 && !(force && age > 60_000) && age < 3_600_000) return keys;
    const res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (res.status !== 200) throw new Error(`Access key fetch returned HTTP ${res.status}`);
    const doc = (await res.json()) as { keys?: Jwk[] };
    keys = Array.isArray(doc.keys) ? doc.keys : [];
    fetchedAt = Date.now();
    return keys;
  };
}

function toKey(jwk: Jwk): KeyObject | null {
  if (jwk.kty !== "RSA") return null;
  try {
    return createPublicKey({ key: jwk as never, format: "jwk" });
  } catch {
    return null;
  }
}

/** Verify the token. Returns the claims, or a short reason for the log (never shown to the requester). */
export async function verifyAccessJwt(token: string | undefined, config: AccessConfig, keys: KeySource, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ ok: true; claims: AccessClaims } | { ok: false; reason: string }> {
  if (!token) return { ok: false, reason: "no Access token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "token is not a JWT" };
  const [h, p, s] = parts as [string, string, string];
  const header = parsePart(h);
  const claims = parsePart(p);
  if (!header || !claims) return { ok: false, reason: "token is not decodable" };
  if (header["alg"] !== "RS256") return { ok: false, reason: `algorithm ${String(header["alg"])} is not accepted` };
  const kid = typeof header["kid"] === "string" ? header["kid"] : null;
  if (!kid) return { ok: false, reason: "token has no key id" };
  let jwk: Jwk | undefined;
  try {
    jwk = (await keys(false)).find((k) => k.kid === kid) ?? (await keys(true)).find((k) => k.kid === kid);
  } catch (err) {
    return { ok: false, reason: `keys unavailable: ${(err as Error).message}` };
  }
  if (!jwk) return { ok: false, reason: "unknown key id" };
  const key = toKey(jwk);
  if (!key) return { ok: false, reason: "key is not usable" };
  if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, b64(s))) return { ok: false, reason: "signature does not verify" };
  if (claims["iss"] !== `https://${config.teamDomain}`) return { ok: false, reason: "wrong issuer" };
  const aud = claims["aud"];
  if (!(Array.isArray(aud) ? aud.includes(config.aud) : aud === config.aud)) return { ok: false, reason: "wrong audience" };
  const exp = claims["exp"];
  if (typeof exp !== "number" || exp + SKEW_SECONDS < nowSeconds) return { ok: false, reason: "token expired" };
  const nbf = claims["nbf"];
  if (typeof nbf === "number" && nbf - SKEW_SECONDS > nowSeconds) return { ok: false, reason: "token not yet valid" };
  const email = typeof claims["email"] === "string" ? claims["email"] : "";
  const sub = typeof claims["sub"] === "string" ? claims["sub"] : "";
  const commonName = typeof claims["common_name"] === "string" ? claims["common_name"] : "";
  if (email === "" && commonName !== "") {
    if (!config.allowedServiceTokens?.includes(commonName)) return { ok: false, reason: "service token is not allowed" };
    return { ok: true, claims: { email: "", serviceToken: commonName, sub, exp } };
  }
  if (email === "") return { ok: false, reason: "token has no email" };
  if (config.allowedEmails && !config.allowedEmails.some((e) => e.toLowerCase() === email.toLowerCase())) return { ok: false, reason: "email is not allowed" };
  return { ok: true, claims: { email, sub, exp } };
}

/**
 * The files a browser or an installer fetches without a sign-in when it saves the page as an app. Cloudflare Access lets exactly these paths through unauthenticated (a bypass rule scoped to each path), so the hub serves them
 * without a token too. Nothing else is public, and only a GET reaches them.
 */
const PUBLIC_INSTALL_PATHS = new Set(["/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png", "/favicon-32.png"]);

export function isPublicInstallAsset(method: string | undefined, pathname: string): boolean {
  return method === "GET" && PUBLIC_INSTALL_PATHS.has(pathname);
}

/** A service token reaches only the tray panel's own endpoints, the plan and run steps of a control action, and the action log it reads the result from. Nothing else. */
export function serviceTokenMayReach(method: string | undefined, pathname: string): boolean {
  if (pathname === "/api/tray" || pathname.startsWith("/api/tray/")) return true;
  if (method === "GET" && pathname === "/api/services/actions") return true;
  return method === "POST" && (pathname === "/api/services/actions/plan" || pathname === "/api/services/actions/run");
}
