import { ApiError } from "./errors";

/** Compare fixed-size digests; never include credentials in errors or logs. */
export async function authenticate(request: Request, configuredToken?: string): Promise<"owner"> {
  if (!configuredToken || configuredToken.length < 24) {
    throw new ApiError(503,"auth_unconfigured","API authentication is not configured.");
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match || match[1].length > 512) throw new ApiError(401,"unauthorized","Authentication required.");
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256",encoder.encode(match[1])),
    crypto.subtle.digest("SHA-256",encoder.encode(configuredToken)),
  ]);
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let different = 0;
  for (let i=0; i<a.length; i++) different |= a[i] ^ b[i];
  if (different) throw new ApiError(401,"unauthorized","Authentication required.");
  return "owner";
}
