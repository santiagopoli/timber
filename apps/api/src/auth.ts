import { ApiError, json } from "./errors";

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();
const unauthorized = () => new ApiError(401, "unauthorized", "Authentication required.");

function configuredCredential(token?: string): string {
  if (!token || token.length < 24 || token.length > 512) {
    throw new ApiError(503, "auth_unconfigured", "API authentication is not configured.");
  }
  return token;
}

/** Compare fixed-size digests; never include credentials in errors or logs. */
async function authenticateBearer(request: Request, configuredToken: string): Promise<"owner"> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match || match[1].length > 512) throw unauthorized();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256",encoder.encode(match[1])),
    crypto.subtle.digest("SHA-256",encoder.encode(configuredToken)),
  ]);
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let different = 0;
  for (let i=0; i<a.length; i++) different |= a[i] ^ b[i];
  if (different) throw unauthorized();
  return "owner";
}

function sessionCookie(url: URL): {name: string; secure: string} {
  if (url.protocol === "https:") return {name: "__Host-timber_session", secure: "; Secure"};
  // Local development never reuses a production session or weakens its cookie.
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return {name: "timber_session_dev", secure: ""};
  }
  throw new ApiError(503, "session_https_required", "Console sessions require HTTPS.");
}

/** Cookies authorize only same-origin console fetches, never forms or navigation. */
function requireConsoleRequest(request: Request): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const mode = request.headers.get("sec-fetch-mode");
  if (request.headers.get("x-timber-client") !== "console"
    || (origin !== null ? origin !== new URL(request.url).origin : site !== "same-origin")
    || (site !== null && site !== "same-origin")
    || (mode !== null && !["cors", "same-origin"].includes(mode))) {
    throw new ApiError(403, "session_origin_denied", "Use the Timber console to access this session.");
  }
}

function encoded(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signingKey(token: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(token), {name: "HMAC", hash: "SHA-256"}, false, ["sign", "verify"]);
}

function sessionPayload(url: URL, value: string): Uint8Array {
  return encoder.encode(`timber-console-session:v1\n${url.origin}\n${value}`);
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 8192) throw unauthorized();
  const matches = header.split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (matches.length > 1) throw unauthorized();
  return matches[0]?.slice(name.length + 1);
}

async function authenticateSession(request: Request, token: string): Promise<{expiresAt: string}> {
  const url = new URL(request.url);
  const value = readCookie(request, sessionCookie(url).name);
  if (!value) throw unauthorized();
  requireConsoleRequest(request);
  // Fixed-size fields keep malformed inputs bounded and avoid ambiguous encodings.
  const match = /^v1\.([0-9]{10})\.([0-9]{10})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) throw unauthorized();
  const issuedAt = Number(match[1]), expiresAt = Number(match[2]);
  const now = Math.floor(Date.now() / 1000);
  if (issuedAt > now + 60 || expiresAt <= now || expiresAt - issuedAt !== SESSION_SECONDS) throw unauthorized();
  const signature = Uint8Array.from(atob(match[4].replace(/-/g, "+").replace(/_/g, "/") + "="), char => char.charCodeAt(0));
  if (encoded(signature) !== match[4]) throw unauthorized();
  const payload = value.slice(0, value.lastIndexOf("."));
  if (!await crypto.subtle.verify("HMAC", await signingKey(token), signature, sessionPayload(url, payload))) throw unauthorized();
  return {expiresAt: new Date(expiresAt * 1000).toISOString()};
}

/** Explicit bearer credentials take precedence; an invalid header never falls back. */
export async function authenticate(request: Request, configuredToken?: string): Promise<"owner"> {
  const token = configuredCredential(configuredToken);
  if (request.headers.has("authorization")) return authenticateBearer(request, token);
  await authenticateSession(request, token);
  return "owner";
}

/** No credential material is returned to JavaScript or stored in browser storage. */
export async function consoleSession(request: Request, configuredToken?: string): Promise<Response> {
  const token = configuredCredential(configuredToken);
  if (!["GET", "POST", "DELETE"].includes(request.method)) throw new ApiError(405, "method_not_allowed", "Method not allowed.");
  requireConsoleRequest(request);
  const url = new URL(request.url);
  const cookie = sessionCookie(url);
  if (request.method === "GET") return json({authenticated: true, ...await authenticateSession(request, token)});
  if (request.method === "DELETE") {
    // Clearing this browser's cookie remains possible after expiration or rotation.
    const response = json({authenticated: false});
    response.headers.set("set-cookie", `${cookie.name}=; Path=/; HttpOnly; SameSite=Strict${cookie.secure}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    return response;
  }
  await authenticateBearer(request, token);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + SESSION_SECONDS;
  const value = `v1.${issuedAt}.${expiresAt}.${encoded(crypto.getRandomValues(new Uint8Array(32)))}`;
  const signature = encoded(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(token), sessionPayload(url, value))));
  const response = json({authenticated: true, expiresAt: new Date(expiresAt * 1000).toISOString()});
  response.headers.set("set-cookie", `${cookie.name}=${value}.${signature}; Path=/; HttpOnly; SameSite=Strict${cookie.secure}; Max-Age=${SESSION_SECONDS}; Expires=${new Date(expiresAt * 1000).toUTCString()}`);
  return response;
}
