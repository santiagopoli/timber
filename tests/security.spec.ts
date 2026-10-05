import { describe, expect, it } from "vitest";
import { authenticate } from "../apps/api/src/auth";
import { errorResponse } from "../apps/api/src/errors";
import { body, parseAction, parseBotInput, parseMessage } from "../apps/api/src/validation";

// Public, deliberately non-secret test credential. Never used by a deployment.
const token = "test-only-botspace-owner-token-000000";
const request = (authorization?: string, suffix = "") => new Request(`https://botspace.test/v1/bots${suffix}`, {
  headers: authorization ? { authorization } : {},
});

describe("authentication boundary", () => {
  it.each([undefined, "", "short"])("fails closed for unusable configured credentials (%s)", async (configured) => {
    await expect(authenticate(request(`Bearer ${token}`), configured)).rejects.toMatchObject({status: 503});
  });

  it.each([undefined, `Basic ${token}`, "Bearer wrong", `Bearer ${token} extra`, `Bearer ${token},Bearer other`])(
    "rejects absent, wrong, or ambiguous authorization (%s)", async (authorization) => {
      await expect(authenticate(request(authorization), token)).rejects.toMatchObject({status: 401});
    },
  );

  it("does not accept credentials in a URL", async () => {
    await expect(authenticate(request(undefined, `?token=${token}`), token)).rejects.toMatchObject({status: 401});
  });

  it("authenticates the exact configured owner credential", async () => {
    await expect(authenticate(request(`Bearer ${token}`), token)).resolves.toBe("owner");
  });

  it("does not leak upstream secrets in public errors", async () => {
    const response = errorResponse(new Error(`Provider failed with secret ${token}`));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(token);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("untrusted request validation", () => {
  it.each(["../private", "nested/../../private", "/etc/passwd", "/workspace-other/secret", "file\0.txt"])(
    "rejects workspace escape %s", (path) => {
      for (const type of ["readFile", "writeFile", "listFiles"]) {
        expect(() => parseAction({type, path, content: "test"})).toThrow();
      }
    },
  );

  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "https://user:password@example.com/"])(
    "rejects non-web or credential-bearing navigation %s", (url) => {
      expect(() => parseAction({type: "navigate", url})).toThrow();
    },
  );

  it("strips unrecognized action fields before approval or execution", () => {
    expect(parseAction({type: "readFile", path: "notes.txt", command: "unexpected", approved: true})).toEqual({type: "readFile", path: "notes.txt"});
  });

  it("rejects non-finite input coordinates and invalid execution bounds", () => {
    expect(() => parseAction({type: "click", x: Number.NaN, y: 0})).toThrow();
    expect(() => parseAction({type: "exec", command: "true", timeoutMs: Infinity})).toThrow();
    expect(() => parseAction({type: "exec", command: "true", timeoutMs: -1})).toThrow();
  });

  it("rejects unusable bot identities and malformed messages", () => {
    expect(() => parseBotInput({name: "   "})).toThrow();
    expect(() => parseBotInput({name: "Ada", runtime: "invalid", model: "arbitrary-url"})).toThrow();
    expect(() => parseMessage({text: "hello"})).toThrow();
    expect(() => parseMessage({text: " ", operationId: "message-1"})).toThrow();
    expect(() => parseMessage({text: "hello", operationId: "../elsewhere"})).toThrow();
  });

  it("rejects oversized bodies even without a trustworthy Content-Length", async () => {
    await expect(body(new Request("https://botspace.test/v1/bots", {
      method: "POST", body: JSON.stringify({text: "a".repeat(300_001)}),
    }))).rejects.toMatchObject({status: 413});
  });

  it("rejects malformed JSON and non-object bodies", async () => {
    for (const content of ["{", "null", "[]", "true"]) {
      await expect(body(new Request("https://botspace.test/v1/bots", {method: "POST", body: content})))
        .rejects.toMatchObject({status: 400});
    }
  });
});
