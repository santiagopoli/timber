import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerResult, ComputerStatus } from "@botspace/contracts";

const bindings = env as unknown as {REAL_COMPUTER: DurableObjectNamespace};
const PRIVATE_DETAIL = "private-native-error-and-command";
const request = (path: string, botId: string, extra = {}) => new Request(`https://computer.internal${path}`, {
  method: "POST", body: JSON.stringify({botId, ...extra}),
});
function computer() {
  const botId = crypto.randomUUID();
  return {botId, stub: bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId))};
}
afterEach(() => vi.restoreAllMocks());

describe("computer lifecycle status", () => {
  it("does not call a crashed server starting, and probing never starts or touches a computer", async () => {
    const {stub, botId} = computer();
    await runInDurableObject(stub, async (instance, state) => {
      let healthy = true, running = true, probes = 0, starts = 0, renewals = 0;
      const container = {
        get running() {return running;},
        start() {starts++;},
        async setInactivityTimeout() {renewals++;},
        getTcpPort() {return {async fetch() {
          probes++;
          if (!healthy) throw new Error(PRIVATE_DETAIL);
          return Response.json({ok:true, bootId:"existing-boot", desktop:true});
        }};},
      };
      Object.defineProperty(instance, "container", {get: () => container});
      const status = async () => (await instance.fetch(request("/status", botId))).json<ComputerStatus>();

      expect(await status()).toMatchObject({state:"running", capabilities:expect.arrayContaining(["screenshot"])});
      healthy = false;
      const failed = await status();
      expect(failed).toMatchObject({state:"unavailable", error:{code:"computer_not_ready"}});
      expect(failed.capabilities).not.toContain("screenshot");
      expect(JSON.stringify(failed)).not.toContain(PRIVATE_DETAIL);
      expect(await status()).toEqual(failed);
      running = false;
      expect(await status()).toMatchObject({state:"stopped"});
      expect(probes).toBe(3);
      expect(starts).toBe(0);
      expect(renewals).toBe(0);
      expect(await state.storage.get("lastActivity")).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("shows starting only during initialization, then runs once and reuses the same container", async () => {
    const {stub, botId} = computer();
    await runInDurableObject(stub, async (instance, state) => {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => {release = resolve;});
      const waiting = new Promise<void>(resolve => {entered = resolve;});
      let running = false, starts = 0, effects = 0, initializing = true;
      const container = {
        get running() {return running;}, images:{base:"test-image"},
        start() {running = true; starts++;},
        async setInactivityTimeout() {if (initializing) {entered(); await gate; initializing = false;}},
        getTcpPort() {return {async fetch(input: string) {
          if (new URL(input).pathname === "/health") return Response.json({ok:true, bootId:"new-boot", desktop:true});
          expect(new URL(input).pathname).toBe("/actions");
          effects++;
          return Response.json({status:"completed",output:"file listing"});
        }};},
      };
      Object.defineProperty(instance, "container", {get: () => container});
      const action = (operationId: string) => instance.fetch(request("/actions", botId, {operationId,action:{type:"listFiles"}}));
      const first = action("first-action");
      await waiting;
      const pending = await (await instance.fetch(request("/status", botId))).json<ComputerStatus>();
      expect(pending.state).toBe("starting");
      expect(effects).toBe(0);
      release();
      const completed = await (await first).json<ComputerResult>();
      expect(completed.status).toBe("completed");
      expect(await (await instance.fetch(request("/status", botId))).json()).toMatchObject({state:"running"});
      expect(await (await action("first-action")).json()).toEqual(completed);
      expect((await action("second-action")).status).toBe(200);
      expect(starts).toBe(1);
      expect(effects).toBe(2);
      expect(await state.storage.get("startupFailure")).toBeUndefined();
    });
  });

  it("persists a safe provisioning timeout instead of freezing in starting or dispatching the requested effect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const {stub, botId} = computer();
    await runInDurableObject(stub, async (instance, state) => {
      let commands = 0, effects = 0;
      const container = {
        running:true,
        async setInactivityTimeout() {},
        getTcpPort() {return {async fetch(input: string) {
          if (new URL(input).pathname === "/health") throw new Error(PRIVATE_DETAIL);
          effects++;
          return Response.json({status:"completed"});
        }};},
        async exec(command: string[]) {
          commands++;
          // Native process-group timeout, not a detached JavaScript deadline:
          // the provisioning command must have stopped before returning failure.
          expect(command.slice(0,6)).toEqual(["timeout","--kill-after=5","240","sh","-c",expect.any(String)]);
          return {async output() {return {exitCode:124};}};
        },
      };
      Object.defineProperty(instance, "container", {get: () => container});
      Object.defineProperty(instance, "env", {value:{COMPUTER_BOOTSTRAP:"true"}});
      const response = await instance.fetch(request("/actions", botId, {operationId:"never-dispatched",action:{type:"listFiles"}}));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({error:{code:"computer_start_timeout"}});
      const status = await (await instance.fetch(request("/status", botId))).json<ComputerStatus>();
      expect(status).toMatchObject({state:"unavailable",error:{code:"computer_start_timeout"}});
      expect(JSON.stringify(status)).not.toContain(PRIVATE_DETAIL);
      expect(commands).toBe(1);
      expect(effects).toBe(0);
      expect(await state.storage.get("operation:never-dispatched")).toBeUndefined();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      Object.defineProperty(instance, "container", {get: () => ({running:true})});
      expect(await (await instance.fetch(request("/status", botId))).json()).toMatchObject({state:"unavailable",error:{code:"computer_start_timeout"}});
    });
  });

  it("clears a previous startup failure only after a newly requested action initializes successfully", async () => {
    const {stub, botId} = computer();
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("startupFailure", "computer_provisioning_failed");
      let effects = 0;
      Object.defineProperty(instance, "container", {get: () => ({
        running:true, async setInactivityTimeout() {},
        getTcpPort() {return {async fetch(input: string) {
          if (new URL(input).pathname === "/health") return Response.json({ok:true,bootId:"recovered",desktop:true});
          effects++;
          return Response.json({status:"completed",output:"recovered"});
        }};},
      })});
      expect(await (await instance.fetch(request("/status", botId))).json()).toMatchObject({state:"unavailable"});
      const response = await instance.fetch(request("/actions", botId, {operationId:"new-explicit-action",action:{type:"listFiles"}}));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({status:"completed"});
      expect(await (await instance.fetch(request("/status", botId))).json()).toMatchObject({state:"running"});
      expect(effects).toBe(1);
      expect(await state.storage.get("startupFailure")).toBeUndefined();
    });
  });
});
