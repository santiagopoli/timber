import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate, consoleSession } from "../apps/api/src/auth";
import type { Env } from "../apps/api/src/env";
import worker from "../apps/api/src/index";

const token = "test-only-botspace-owner-token-000000";
const origin = "https://botspace.test";
const browserHeaders = {"x-timber-client": "console", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors"};
const request = (path = "/v1/session", init: RequestInit = {}, host = origin) => new Request(`${host}${path}`, {
  ...init, headers: {...browserHeaders, ...init.headers},
});
async function login(host = origin): Promise<{cookie: string; response: Response}> {
  const response = await consoleSession(request("/v1/session", {method: "POST", headers: {authorization: `Bearer ${token}`}}, host), token);
  return {cookie: response.headers.get("set-cookie")!.split(";")[0], response};
}

afterEach(() => vi.restoreAllMocks());

describe("persistent console sessions", () => {
  it("sets a host-only persistent HttpOnly Secure cookie without returning credentials to JavaScript", async () => {
    const {cookie, response} = await login();
    const header = response.headers.get("set-cookie")!;
    expect(header).toMatch(/^__Host-timber_session=v1\./);
    for (const flag of ["Path=/", "HttpOnly", "SameSite=Strict", "Secure", "Max-Age=2592000", "Expires="]) expect(header).toContain(flag);
    expect(header).not.toContain("Domain=");
    expect(header).not.toContain(token);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json<{authenticated: boolean; expiresAt: string}>();
    expect(result.authenticated).toBe(true);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now() + 29 * 86400_000);
    expect(Object.keys(result).sort()).toEqual(["authenticated", "expiresAt"]);
    const status = await consoleSession(request("/v1/session", {headers: {cookie}}), token);
    expect(await status.json()).toEqual(result);
    // A fresh request carries only the cookie, as after a reload or browser restart.
    expect(await authenticate(request("/v1/bots", {headers: {cookie}}), token)).toBe("owner");
    expect((await login()).cookie).not.toBe(cookie);
  });

  it("routes login, status and authenticated API reads through the actual Worker", async () => {
    const response = await exports.default.fetch(request("/v1/session", {method: "POST", headers: {authorization: `Bearer ${token}`}}));
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    await response.text();
    const status = await exports.default.fetch(request("/v1/session", {headers: {cookie}}));
    expect(await status.json()).toMatchObject({authenticated: true});
    const bots = await exports.default.fetch(request("/v1/bots", {headers: {cookie}}));
    expect(bots.status).toBe(200);
    expect(await bots.json()).toHaveProperty("bots");
    const rejected = await exports.default.fetch(request("/v1/session", {method: "POST", headers: {authorization: "Bearer incorrect"}}));
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({error: {code: "unauthorized"}});
  });

  it("rejects tampering, duplicate cookies, malformed values and oversized cookie headers", async () => {
    const {cookie} = await login();
    const separator = cookie.indexOf("=");
    const name = cookie.slice(0, separator + 1);
    const value = cookie.slice(separator + 1);
    for (const invalid of [
      cookie.replace("v1.", "v2."),
      `${name}${value.slice(0, -2)}${value.at(-2) === "A" ? "B" : "A"}${value.at(-1)}`,
      `${cookie}; ${cookie}`,
      `${name}${"x".repeat(9000)}`,
      `${name}invalid`,
    ]) {
      await expect(authenticate(request("/v1/bots", {headers: {cookie: invalid}}), token)).rejects.toMatchObject({status: 401});
    }
  });

  it("expires sessions after thirty days and invalidates them when the owner token rotates", async () => {
    const now = Date.now();
    const {cookie} = await login();
    await expect(authenticate(request("/v1/bots", {headers: {cookie}}), `${token}-rotated`)).rejects.toMatchObject({status: 401});
    vi.spyOn(Date, "now").mockReturnValue(now + 30 * 86400_000);
    await expect(authenticate(request("/v1/bots", {headers: {cookie}}), token)).rejects.toMatchObject({status: 401});
  });

  it("binds a session to its exact origin", async () => {
    const {cookie} = await login();
    await expect(authenticate(request("/v1/bots", {headers: {cookie}}, "https://other.test"), token)).rejects.toMatchObject({status: 401});
  });

  it("requires same-origin console fetches even for reads and rejects inconsistent browser provenance", async () => {
    const {cookie} = await login();
    const denied: Record<string, string>[] = [
      {origin: "https://attacker.test"},
      {origin: "null"},
      {"sec-fetch-site": "cross-site"},
      {"sec-fetch-site": "same-site"},
      {"sec-fetch-mode": "navigate"},
      {"x-timber-client": ""},
      {"sec-fetch-site": ""},
    ];
    for (const headers of denied) {
      for (const method of ["GET", "POST", "DELETE"]) {
        await expect(authenticate(request("/v1/bots", {method, headers: {cookie, ...headers}}), token)).rejects.toMatchObject({status: 403});
      }
    }
    // Safari can provide Origin without Fetch Metadata, while ordinary GET fetches
    // often provide same-origin Fetch Metadata without an Origin header.
    await expect(authenticate(new Request(`${origin}/v1/bots`, {headers: {cookie, origin, "x-timber-client": "console"}}), token)).resolves.toBe("owner");
    await expect(authenticate(new Request(`${origin}/v1/bots`, {headers: {cookie, "x-timber-client": "console"}}), token)).rejects.toMatchObject({status: 403});
  });

  it("prevents cross-origin login and logout while allowing local logout after expiration", async () => {
    const {cookie} = await login();
    for (const method of ["POST", "DELETE"]) {
      const response = await exports.default.fetch(request("/v1/session", {method, headers: {origin: "https://attacker.test", cookie, authorization: `Bearer ${token}`}}));
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      await response.text();
    }
    const response = await consoleSession(request("/v1/session", {method: "DELETE", headers: {cookie: "__Host-timber_session=expired"}}), token);
    expect(await response.json()).toEqual({authenticated: false});
    expect(response.headers.get("set-cookie")).toContain("__Host-timber_session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0;");
    // Clearing the cookie leaves a new tab or reload unauthenticated.
    await expect(authenticate(request("/v1/bots"), token)).rejects.toMatchObject({status: 401});
  });

  it("keeps existing bearer API clients compatible and never falls back from an invalid bearer header", async () => {
    const {cookie} = await login();
    await expect(authenticate(new Request(`${origin}/v1/bots`, {headers: {authorization: `Bearer ${token}`}}), token)).resolves.toBe("owner");
    await expect(authenticate(request("/v1/bots", {headers: {cookie, authorization: "Bearer incorrect"}}), token)).rejects.toMatchObject({status: 401});
    await expect(consoleSession(request("/v1/session", {method: "POST", headers: {cookie}}), token)).rejects.toMatchObject({status: 401});
  });

  it("uses a separate localhost cookie and rejects insecure non-local console sessions", async () => {
    const {cookie, response} = await login("http://127.0.0.1:8787");
    expect(cookie).toMatch(/^timber_session_dev=/);
    expect(response.headers.get("set-cookie")).not.toContain("; Secure");
    await expect(authenticate(request("/v1/bots", {headers: {cookie}}, "http://127.0.0.1:8787"), token)).resolves.toBe("owner");
    await expect(login("http://botspace.test")).rejects.toMatchObject({status: 503, code: "session_https_required"});
  });

  it("fails closed when the deployment has no usable owner credential", async () => {
    const {cookie} = await login();
    for (const configured of [undefined, "short", "x".repeat(513)]) {
      const response = await worker.fetch(request("/v1/session", {headers: {cookie}}), {...env as unknown as Env, BOTSPACE_API_TOKEN: configured});
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      await response.text();
    }
  });
});
