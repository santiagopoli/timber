import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../apps/api/src/env";
import type {
  Device,
  DeviceJob,
  DevicePairing,
} from "../packages/contracts/src/devices";
import { deviceProofHeaders } from "../packages/contracts/src/devices";
const bindings = env as unknown as Env & { DEVICES: DurableObjectNamespace },
  headers = {
    authorization: "Bearer test-only-botspace-owner-token-000000",
    "content-type": "application/json",
  };
const stub = () => bindings.DEVICES.get(bindings.DEVICES.idFromName("owner"));
const api = async (
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) => {
  const response = await exports.default.fetch(`https://timber.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: response.headers,
  });
};
async function pair() {
  const keys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const response = await exports.default.fetch(
    "https://timber.test/v1/device-connect/pairings",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey,
        name: "Personal Mac",
        platform: "darwin",
        version: "test",
        workspaces: [
          {
            id: "project",
            name: "Project",
            path: "/Users/owner/project",
            capabilities: [
              "diagnostics",
              "files.read",
              "files.write",
              "host.shell",
              "agent.run",
            ],
          },
        ],
      }),
    },
  );
  expect(response.status).toBe(201);
  const pairing = await response.json<DevicePairing>();
  const approved = await api("/v1/devices/pairings/approve", {
    code: pairing.code,
  });
  expect(approved.status).toBe(200);
  const { device } = await approved.json<{ device: Device }>();
  return { keys, pairing, device };
}
async function signed(
  id: string,
  key: CryptoKey,
  path: string,
  input: unknown = {},
  overrides?: { time?: string; nonce?: string },
) {
  const body = JSON.stringify(input),
    proof = await deviceProofHeaders(key, {
      id,
      path,
      method: "POST",
      body,
      ...overrides,
    });
  const response = await exports.default.fetch(`https://timber.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...proof },
    body,
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: response.headers,
  });
}
async function bot() {
  const response = await api("/v1/bots", { name: "Device bot" });
  expect(response.status).toBe(201);
  return (await response.json<{ bot: { id: string } }>()).bot;
}
async function grant(
  device: Device,
  botId: string,
  permissions = [
    "diagnostics",
    "files.read",
    "files.write",
    "host.shell",
    "agent.run",
  ],
) {
  const response = await api(`/v1/devices/${device.id}/grants`, {
    botId,
    workspaceIds: ["project"],
    permissions,
  });
  expect(response.status).toBe(200);
  return (await response.json<{ device: Device }>()).device;
}
async function internal(path: string, input?: unknown) {
  const response = await stub().fetch(`https://devices/internal${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      "x-timber-internal": "computer",
      "content-type": "application/json",
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: response.headers,
  });
}
async function enqueue(
  device: Device,
  botId: string,
  action: unknown = { type: "readFile", path: "README.md" },
  extra: Record<string, unknown> = {},
) {
  const response = await internal("/jobs", {
    deviceId: device.id,
    botId,
    workspaceId: "project",
    operationId: crypto.randomUUID(),
    type: "computer",
    action,
    ...extra,
  });
  expect(response.status).toBe(202);
  return (await response.json<{ job: DeviceJob }>()).job;
}
async function agent(context: Awaited<ReturnType<typeof pair>>, botId: string) {
  const configured = await api(
    `/v1/bots/${botId}`,
    {
      model: "@cf/zai-org/glm-4.7-flash",
      executionTarget: {
        kind: "device",
        deviceId: context.device.id,
        workspaceId: "project",
        agentMode: "local",
      },
    },
    "PATCH",
  );
  expect(configured.status).toBe(200);
  await configured.text();
  const operationId = crypto.randomUUID();
  const receipt = await api(`/v1/bots/${botId}/messages`, {
    operationId,
    text: "Inspect the project.",
  });
  expect(receipt.status).toBe(202);
  await receipt.text();
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await internal(
      `/operations?deviceId=${context.device.id}&scopeId=${botId}&operationId=${operationId}`,
    );
    const { job } = await response.json<{ job: DeviceJob | null }>();
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Local agent admission was not durably queued.");
}
const poll = async (context: Awaited<ReturnType<typeof pair>>) =>
  (
    await signed(
      context.device.id,
      context.keys.privateKey,
      `/v1/device-connect/${context.device.id}/jobs/poll`,
    )
  ).json<{ jobs: DeviceJob[]; cancellations: Array<{ jobId: string }> }>();
async function start(
  context: Awaited<ReturnType<typeof pair>>,
  job: DeviceJob,
) {
  const response = await signed(
    context.device.id,
    context.keys.privateKey,
    `/v1/device-connect/${context.device.id}/jobs/${job.id}/start`,
    { claimToken: job.claimToken },
  );
  expect(response.status).toBe(200);
}
async function result(
  context: Awaited<ReturnType<typeof pair>>,
  job: DeviceJob,
  status = "completed",
  extra: Record<string, unknown> = {},
) {
  return signed(
    context.device.id,
    context.keys.privateKey,
    `/v1/device-connect/${context.device.id}/jobs/${job.id}/result`,
    {
      claimToken: job.claimToken,
      result: { operationId: job.operationId, status, ...extra },
    },
  );
}

describe("owned machine proof, grants and durable effects", () => {
  it("keeps managed commands observable after their agent ends and isolates computer effects while another agent can infer", async () => {
    const context = await pair(),
      a = await bot(),
      b = await bot();
    await grant(context.device, a.id);
    await grant(context.device, b.id);
    const submittedAgent = await agent(context, a.id);
    const activeAgent = (await poll(context)).jobs.find(
      (job) => job.id === submittedAgent.id,
    )!;
    expect(activeAgent).toBeDefined();
    await start(context, activeAgent);
    const status = await (
      await internal(`/devices/${context.device.id}`)
    ).json<{ heldWorkspaces: unknown[] }>();
    expect(status.heldWorkspaces).toEqual([]);
    const submittedExec = await enqueue(
      context.device,
      a.id,
      { type: "exec", command: "sleep 60" },
      {
        parentJobId: activeAgent.id,
        approval: { authorized: true, mode: "automatic" },
      },
    );
    const command = (await poll(context)).jobs.find(
      (job) => job.id === submittedExec.id,
    )!;
    await start(context, command);
    const processId = "device-process:" + command.id;
    expect(
      (
        await result(context, command, "running", {
          processId,
          processKnown: true,
        })
      ).status,
    ).toBe(200);
    for (const [actor, id] of [
      [a.id, "device-process:forged"],
      [b.id, processId],
    ]) {
      expect(
        (
          await internal("/jobs", {
            deviceId: context.device.id,
            botId: actor,
            workspaceId: "project",
            operationId: crypto.randomUUID(),
            type: "computer",
            action: { type: "execPoll", processId: id },
          })
        ).status,
      ).toBe(403);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const queued = await enqueue(
        context.device,
        a.id,
        { type: "execPoll", processId },
        { parentJobId: activeAgent.id },
      );
      expect(queued.parentJobId).toBe(command.id);
      const control = (await poll(context)).jobs.find(
        (job) => job.id === queued.id,
      )!;
      expect(control).toBeDefined();
      await start(context, control);
      expect(
        (
          await result(context, control, "running", {
            processId,
            processKnown: true,
          })
        ).status,
      ).toBe(200);
      const receipt = await (
        await internal(`/jobs/${control.id}`)
      ).json<{ job: DeviceJob }>();
      expect(receipt.job.state).toBe("completed");
      expect(receipt.job.result?.status).toBe("running");
    }
    const ownRead = await enqueue(context.device, a.id, undefined, {
      parentJobId: activeAgent.id,
    });
    const reading = (await poll(context)).jobs.find(
      (job) => job.id === ownRead.id,
    )!;
    await start(context, reading);
    expect((await result(context, reading)).status).toBe(200);
    const secondSubmitted = await enqueue(
      context.device,
      a.id,
      { type: "exec", command: "sleep 90" },
      {
        parentJobId: activeAgent.id,
        approval: { authorized: true, mode: "automatic" },
      },
    );
    const secondCommand = (await poll(context)).jobs.find(
      (job) => job.id === secondSubmitted.id,
    )!;
    await start(context, secondCommand);
    const secondProcessId = "device-process:" + secondCommand.id;
    expect(
      (
        await result(context, secondCommand, "running", {
          processId: secondProcessId,
          processKnown: true,
        })
      ).status,
    ).toBe(200);
    const ended = await signed(
      context.device.id,
      context.keys.privateKey,
      `/v1/device-connect/${context.device.id}/jobs/${activeAgent.id}/result`,
      {
        claimToken: activeAgent.claimToken,
        agentResult: {
          status: "done",
          text: "Background command started.",
          kind: "final",
        },
      },
    );
    expect(ended.status).toBe(200);
    await ended.text();
    const submittedOtherAgent = await agent(context, b.id);
    const otherAgent = (await poll(context)).jobs.find(
      (job) => job.id === submittedOtherAgent.id,
    )!;
    expect(otherAgent).toBeDefined();
    await start(context, otherAgent);
    const otherRead = await enqueue(context.device, b.id, undefined, {
      parentJobId: otherAgent.id,
    });
    expect((await poll(context)).jobs).toEqual([]);
    const finalPoll = await enqueue(
      context.device,
      a.id,
      { type: "execPoll", processId },
      { parentJobId: activeAgent.id },
    );
    expect(finalPoll.parentJobId).toBe(command.id);
    const control = (await poll(context)).jobs.find(
      (job) => job.id === finalPoll.id,
    )!;
    await start(context, control);
    expect(
      (
        await result(context, control, "completed", {
          processId,
          processKnown: true,
          exitCode: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (await (await internal(`/jobs/${command.id}`)).json<{ job: DeviceJob }>())
        .job.state,
    ).toBe("completed");
    expect((await poll(context)).jobs).toEqual([]);
    const holder = await (
      await internal(`/devices/${context.device.id}`)
    ).json<{ heldWorkspaces: Array<{ jobId: string }> }>();
    expect(holder.heldWorkspaces[0]?.jobId).toBe(secondCommand.id);
    const secondFinal = await enqueue(
      context.device,
      a.id,
      { type: "execPoll", processId: secondProcessId },
      { parentJobId: activeAgent.id },
    );
    const secondControl = (await poll(context)).jobs.find(
      (job) => job.id === secondFinal.id,
    )!;
    await start(context, secondControl);
    expect(
      (
        await result(context, secondControl, "completed", {
          processId: secondProcessId,
          processKnown: true,
          exitCode: 0,
        })
      ).status,
    ).toBe(200);
    expect((await poll(context)).jobs.map((job) => job.id)).toEqual([
      otherRead.id,
    ]);
  }, 30_000);
  it("rejects oversized unauthenticated pairing bodies before parsing or persistence", async () => {
    const response = await exports.default.fetch(
      "https://timber.test/v1/device-connect/pairings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x".repeat(40_000) }),
      },
    );
    expect(response.status).toBe(413);
    await response.text();
  });
  it("preserves a running effect when identical owner grant submission is retried", async () => {
    const context = await pair(),
      b = await bot();
    const initial = await grant(context.device, b.id);
    await enqueue(context.device, b.id);
    const active = (await poll(context)).jobs[0];
    await start(context, active);
    const repeated = await grant(context.device, b.id);
    expect(repeated.grants[0].epoch).toBe(initial.grants[0].epoch);
    expect((await poll(context)).cancellations).toEqual([]);
    expect((await result(context, active)).status).toBe(200);
  });
  it("bot cleanup revokes grants and fences delivered work while retaining running leases until acknowledgment", async () => {
    const context = await pair(),
      a = await bot(),
      b = await bot();
    await grant(context.device, a.id);
    await grant(context.device, b.id);
    await enqueue(context.device, a.id);
    const active = (await poll(context)).jobs[0];
    await start(context, active);
    const waiting = await enqueue(context.device, a.id);
    const other = await enqueue(context.device, b.id);
    const revoked = await internal(`/bots/${a.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    await revoked.text();
    expect(
      (
        await api(`/v1/devices/${context.device.id}/grants`, {
          botId: a.id,
          workspaceIds: ["project"],
          permissions: ["files.read"],
        })
      ).status,
    ).toBe(403);
    const devices = await (
      await api("/v1/devices")
    ).json<{ devices: Device[] }>();
    expect(
      devices.devices
        .find((d) => d.id === context.device.id)
        ?.grants.map((g) => g.botId),
    ).toEqual([b.id]);
    expect(
      (await (await internal(`/jobs/${waiting.id}`)).json<{ job: DeviceJob }>())
        .job.state,
    ).toBe("cancelled");
    const blocked = await poll(context);
    expect(blocked.jobs).toEqual([]);
    expect(blocked.cancellations.some((item) => item.jobId === active.id)).toBe(
      true,
    );
    expect((await result(context, active, "cancelled")).status).toBe(200);
    expect((await poll(context)).jobs.map((j) => j.id)).toEqual([other.id]);
  });
  it("retains an unknown managed process fence across eviction until confirmed cancellation", async () => {
    const context = await pair(),
      a = await bot(),
      b = await bot();
    await grant(context.device, a.id);
    await grant(context.device, b.id);
    await enqueue(
      context.device,
      a.id,
      { type: "exec", command: "sleep 60" },
      { approval: { authorized: true, mode: "automatic" } },
    );
    const active = (await poll(context)).jobs[0];
    await start(context, active);
    const other = await enqueue(context.device, b.id);
    expect(
      (await result(context, active, "interrupted", { processKnown: false }))
        .status,
    ).toBe(200);
    await evictDurableObject(stub());
    expect((await poll(context)).jobs).toEqual([]);
    expect(
      (await poll(context)).cancellations.some(
        (item) => item.jobId === active.id,
      ),
    ).toBe(true);
    const submitted = await enqueue(context.device, a.id, {
      type: "execCancel",
      processId: active.operationId,
    });
    const control = (await poll(context)).jobs.find(
      (job) => job.id === submitted.id,
    )!;
    await start(context, control);
    expect(
      (await result(context, control, "cancelled", { processKnown: true }))
        .status,
    ).toBe(200);
    expect((await poll(context)).jobs.map((j) => j.id)).toEqual([other.id]);
  });
  it("admits one owned child effect at a time under a held workspace and rejects another bot's parent", async () => {
    const context = await pair(),
      a = await bot(),
      b = await bot();
    await grant(context.device, a.id);
    await grant(context.device, b.id);
    await enqueue(
      context.device,
      a.id,
      { type: "exec", command: "sleep 60" },
      { approval: { authorized: true, mode: "automatic" } },
    );
    const parent = (await poll(context)).jobs[0];
    await start(context, parent);
    expect(
      (
        await result(context, parent, "running", {
          processId: "device-process:" + parent.id,
          processKnown: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await internal("/jobs", {
          deviceId: context.device.id,
          workspaceId: "project",
          botId: b.id,
          type: "computer",
          operationId: crypto.randomUUID(),
          parentJobId: parent.id,
          action: { type: "readFile", path: "README" },
        })
      ).status,
    ).toBe(403);
    const first = await enqueue(context.device, a.id, undefined, {
      parentJobId: parent.id,
    });
    const second = await enqueue(context.device, a.id, undefined, {
      parentJobId: parent.id,
    });
    const responses = await Promise.all([poll(context), poll(context)]);
    expect(responses.flatMap((r) => r.jobs).map((j) => j.id)).toEqual([
      first.id,
    ]);
    const child = responses.flatMap((r) => r.jobs)[0];
    await start(context, child);
    expect((await result(context, child)).status).toBe(200);
    expect((await poll(context)).jobs.map((j) => j.id)).toEqual([second.id]);
  });
  it("requires owner approval, keeps credentials out of device DTOs and denies public internal routes", async () => {
    const context = await pair();
    const denied = await exports.default.fetch(
      "https://timber.test/v1/devices",
    );
    expect(denied.status).toBe(401);
    await denied.text();
    const forged = await exports.default.fetch(
      "https://timber.test/v1/device-connect/internal/jobs",
      {
        method: "POST",
        headers: { "x-timber-internal": "computer" },
        body: "{}",
      },
    );
    expect(forged.status).not.toBe(200);
    await forged.text();
    const approved = await signed(
      context.pairing.pairingId,
      context.keys.privateKey,
      `/v1/device-connect/pairings/${context.pairing.pairingId}/poll`,
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      status: "approved",
      deviceId: context.device.id,
      device: { grants: [] },
    });
    const replay = await api("/v1/devices/pairings/approve", {
      code: context.pairing.code,
    });
    expect((await replay.json<{ device: Device }>()).device.id).toBe(
      context.device.id,
    );
    expect(JSON.stringify(context.device)).not.toContain("publicKey");
  });
  it("rejects signature tampering, wrong keys, expired time and replayed nonces", async () => {
    const context = await pair(),
      path = `/v1/device-connect/${context.device.id}/heartbeat`,
      nonce = crypto.randomUUID();
    expect(
      (
        await signed(
          context.device.id,
          context.keys.privateKey,
          path,
          {},
          { nonce },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await signed(
          context.device.id,
          context.keys.privateKey,
          path,
          {},
          { nonce },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await signed(
          context.device.id,
          context.keys.privateKey,
          path,
          {},
          { time: String(Date.now() - 120_000) },
        )
      ).status,
    ).toBe(401);
    const other = await pair();
    expect(
      (await signed(context.device.id, other.keys.privateKey, path)).status,
    ).toBe(401);
    const proof = await deviceProofHeaders(context.keys.privateKey, {
      id: context.device.id,
      path,
      method: "POST",
      body: "{}",
    });
    const tampered = await exports.default.fetch(`https://timber.test${path}`, {
      method: "POST",
      headers: proof,
      body: '{"version":"tampered"}',
    });
    expect(tampered.status).toBe(401);
    await tampered.text();
  });
  it("bounds pairing lifetime and rejects workspace/bot/unsafe permission escalation", async () => {
    const context = await pair(),
      b = await bot();
    await runInDurableObject(stub(), (_i, state) => {
      const row = state.storage.sql
        .exec<{
          data: string;
        }>("SELECT data FROM pairings WHERE id=?", context.pairing.pairingId)
        .one();
      state.storage.sql.exec(
        "UPDATE pairings SET data=? WHERE id=?",
        JSON.stringify({
          ...JSON.parse(row.data),
          expiresAt: new Date(Date.now() - 1).toISOString(),
        }),
        context.pairing.pairingId,
      );
    });
    expect(
      (
        await signed(
          context.pairing.pairingId,
          context.keys.privateKey,
          `/v1/device-connect/pairings/${context.pairing.pairingId}/poll`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api(`/v1/devices/${context.device.id}/grants`, {
          botId: b.id,
          workspaceIds: ["unknown"],
          permissions: ["host.shell"],
        })
      ).status,
    ).toBe(400);
    await grant(context.device, b.id, ["files.read"]);
    const unsafe = await internal("/jobs", {
      deviceId: context.device.id,
      botId: b.id,
      workspaceId: "project",
      operationId: "unsafe",
      type: "computer",
      action: { type: "exec", command: "whoami" },
      approval: { authorized: true, mode: "automatic" },
    });
    expect(unsafe.status).toBe(403);
    const foreign = await internal("/jobs", {
      deviceId: context.device.id,
      botId: crypto.randomUUID(),
      workspaceId: "project",
      operationId: "foreign",
      type: "computer",
      action: { type: "readFile", path: "README" },
    });
    expect(foreign.status).toBe(403);
  });
  it("deduplicates effects across eviction and never automatically redelivers an uncertain claim", async () => {
    const context = await pair(),
      b = await bot();
    await grant(context.device, b.id);
    const input = {
      deviceId: context.device.id,
      botId: b.id,
      workspaceId: "project",
      operationId: "stable-read",
      type: "computer",
      action: { type: "readFile", path: "README" },
    };
    const first = await internal("/jobs", input),
      job = (await first.json<{ job: DeviceJob }>()).job;
    const retry = await internal("/jobs", input);
    expect((await retry.json<{ job: DeviceJob }>()).job.id).toBe(job.id);
    expect(
      (
        await internal("/jobs", {
          ...input,
          action: { type: "readFile", path: "different" },
        })
      ).status,
    ).toBe(409);
    const delivered = (await poll(context)).jobs[0];
    expect(delivered.id).toBe(job.id);
    await evictDurableObject(stub());
    expect((await poll(context)).jobs).toHaveLength(0);
    await start(context, delivered);
    expect(
      (
        await result(context, delivered, "completed", {
          output: "saved result",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await result(context, delivered, "completed", {
          output: "saved result",
        })
      ).status,
    ).toBe(200);
    expect(
      (await (await internal(`/jobs/${job.id}`)).json<{ job: DeviceJob }>()).job
        .result?.output,
    ).toBe("saved result");
  });
  it("serializes workspaces across bots and preserves offline uncertainty until completion", async () => {
    const context = await pair(),
      a = await bot(),
      b = await bot();
    await grant(context.device, a.id);
    await grant(context.device, b.id);
    const first = await enqueue(context.device, a.id),
      second = await enqueue(context.device, b.id);
    const delivered = (await poll(context)).jobs;
    expect(delivered.map((job) => job.id)).toEqual([first.id]);
    await start(context, delivered[0]);
    await runInDurableObject(stub(), (_i, state) => {
      const row = state.storage.sql
        .exec<{
          data: string;
        }>("SELECT data FROM devices WHERE id=?", context.device.id)
        .one();
      state.storage.sql.exec(
        "UPDATE devices SET data=? WHERE id=?",
        JSON.stringify({
          ...JSON.parse(row.data),
          lastSeenAt: new Date(Date.now() - 600000).toISOString(),
        }),
        context.device.id,
      );
    });
    expect((await poll(context)).jobs).toHaveLength(0);
    expect((await result(context, delivered[0])).status).toBe(200);
    expect((await poll(context)).jobs.map((job) => job.id)).toEqual([
      second.id,
    ]);
  });
  it("revokes running jobs with cancellation fences and does not revive old epochs after regrant", async () => {
    const context = await pair(),
      b = await bot();
    await grant(context.device, b.id);
    const queued = await enqueue(context.device, b.id),
      active = (await poll(context)).jobs[0];
    await start(context, active);
    const waiting = await enqueue(context.device, b.id);
    expect(
      (
        await api(
          `/v1/devices/${context.device.id}/grants/${b.id}`,
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    const cancellations = (await poll(context)).cancellations;
    expect(cancellations.some((item) => item.jobId === queued.id)).toBe(true);
    expect(
      (await (await internal(`/jobs/${waiting.id}`)).json<{ job: DeviceJob }>())
        .job.state,
    ).toBe("cancelled");
    await grant(context.device, b.id);
    const later = await enqueue(context.device, b.id);
    expect((await poll(context)).jobs).toHaveLength(0);
    expect((await result(context, active, "cancelled")).status).toBe(200);
    expect((await poll(context)).jobs.map((job) => job.id)).toEqual([later.id]);
  });
});
