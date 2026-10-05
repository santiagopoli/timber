export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {"content-type":"application/json; charset=utf-8", "cache-control":"no-store", "x-content-type-options":"nosniff"},
  });
}
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return json({error:{code:error.code,message:error.message}},error.status);
  // Engine/provider errors can contain credentials, prompts or filesystem paths.
  return json({error:{code:"internal_error",message:"The request could not be completed."}},500);
}
