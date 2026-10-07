interface Env {API:Fetcher;}

/** No owner tokens, credentials, app registry or public arbitrary target proxy.
 * The API service entrypoint performs registry and per-app browser authorization. */
export default {
  fetch(request:Request,env:Env):Promise<Response> {return env.API.fetch(request);},
} satisfies ExportedHandler<Env>;
