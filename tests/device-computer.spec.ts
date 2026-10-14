import { describe, expect, it, vi } from "vitest";
import {
  createExecutionComputerProvider,
  executeDeviceDiagnostic,
} from "../apps/api/src/device-computer";
import type {
  ComputerProvider,
  DeviceJob,
  ExecutionTarget,
} from "@botspace/contracts";
import type { Env } from "../apps/api/src/env";
const deviceId = "11111111-1111-4111-8111-111111111111",
  botId = "22222222-2222-4222-8222-222222222222";
const target: ExecutionTarget = {
  kind: "device",
  deviceId,
  workspaceId: "project",
};
function job(operationId: string): DeviceJob {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    deviceId,
    botId,
    workspaceId: "project",
    operationId,
    type: "computer",
    permission: "files.read",
    grantEpoch: "epoch",
    state: "queued",
    createdAt: "now",
    updatedAt: "now",
  };
}
function cloud(): ComputerProvider {
  return {
    exec: vi.fn(async (_botId, operationId) => ({
      operationId,
      status: "completed" as const,
    })),
    cancel: vi.fn(async (_botId, operationId) => ({
      operationId,
      status: "cancelled" as const,
    })),
    status: vi.fn(async () => ({
      id: botId,
      provider: "cloudflare" as const,
      state: "stopped" as const,
      capabilities: [],
    })),
    checkpoint: vi.fn(async () => ({
      operationId: "cloud-checkpoint",
      status: "completed" as const,
    })),
  };
}
describe("owned-machine ComputerProvider integration", () => {
  it("waits for actual file output and sends frozen native scope and host authorization", async () => {
    const fallback = cloud(),
      requests: Array<{ path: string; input?: unknown }> = [];
    const provider = createExecutionComputerProvider({} as Env, {
      cloud: fallback,
      scope: () => ({ botId, taskId: "task" }),
      targetForOperation: () => target,
      nativeOperationIdForOperation: () => "native-input",
      approvalForOperation: () => ({
        authorized: true,
        mode: "approved",
        approvalId: "approved",
      }),
      parentJobId: () => "parent",
      wait: async () => {},
      request: async (path, input) => {
        requests.push({ path, input });
        return input
          ? { job: job("read") }
          : {
              job: {
                ...job("read"),
                state: "completed",
                result: {
                  operationId: "read",
                  status: "completed",
                  output: "actual device bytes",
                },
              },
            };
      },
    });
    expect(
      await provider.exec(botId, "read", { type: "readFile", path: "README" }),
    ).toMatchObject({ status: "completed", output: "actual device bytes" });
    expect(requests[0].input).toMatchObject({
      botId,
      taskId: "task",
      nativeOperationId: "native-input",
      parentJobId: "parent",
      scopeId: "task",
      approval: { authorized: true, mode: "approved" },
    });
    expect(fallback.exec).not.toHaveBeenCalled();
  });
  it("retains a stable public process ID while translating the runner process and observing after recovery", async () => {
    const original = {
      ...job("exec-original"),
      state: "running" as const,
      permission: "host.shell" as const,
      result: {
        operationId: "exec-original",
        processId: "device-process:unique-job",
        status: "running" as const,
        output: "started",
      },
    };
    const requests: Array<{ path: string; input?: unknown }> = [];
    const provider = createExecutionComputerProvider({} as Env, {
      cloud: cloud(),
      scope: () => ({ botId }),
      targetForOperation: () => target,
      wait: async () => {},
      request: async (path, input) => {
        requests.push({ path, input });
        if (path.startsWith("/operations")) return { job: original };
        return {
          job: {
            ...job("observe"),
            state: "completed",
            result: {
              operationId: "observe",
              processId: "device-process:unique-job",
              status: "completed",
              output: "finished",
            },
          },
        };
      },
    });
    const result = await provider.exec(botId, "observe", {
      type: "execPoll",
      processId: "exec-original",
      yieldMs: 0,
    });
    expect(result).toMatchObject({
      operationId: "observe",
      processId: "exec-original",
      status: "completed",
      output: "finished",
    });
    expect(requests[1].input).toMatchObject({
      action: { type: "execPoll", processId: "device-process:unique-job" },
    });
    expect(
      requests.some(
        (request) =>
          (request.input as { action?: { type: string } })?.action?.type ===
          "exec",
      ),
    ).toBe(false);
  });
  it("requests process cancellation without claiming the remote process stopped", async () => {
    const original = {
      ...job("exec-original"),
      state: "running",
      result: {
        operationId: "exec-original",
        processId: "device-process:unique-job",
        status: "running",
      },
    };
    const requests: string[] = [];
    const provider = createExecutionComputerProvider({} as Env, {
      cloud: cloud(),
      scope: () => ({ botId }),
      targetForOperation: () => target,
      request: async (path) => {
        requests.push(path);
        return { job: original };
      },
    });
    expect(await provider.cancel(botId, "exec-original")).toMatchObject({
      status: "running",
      processId: "exec-original",
    });
    expect(requests[1]).toBe("/jobs/" + original.id + "/cancel");
  });
  it("cancels a queued write before a bounded transport wait reports pending", async () => {
    let clock = 0;
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock),
      requests: string[] = [];
    const provider = createExecutionComputerProvider({} as Env, {
      cloud: cloud(),
      scope: () => ({ botId }),
      targetForOperation: () => target,
      wait: async () => {
        clock = 30_000;
      },
      request: async (path) => {
        requests.push(path);
        return { job: job("write") };
      },
    });
    try {
      await expect(
        provider.exec(botId, "write", {
          type: "writeFile",
          path: "report",
          content: "data",
        }),
      ).rejects.toMatchObject({ code: "device_operation_pending" });
      expect(requests.at(-1)).toBe("/jobs/" + job("write").id + "/cancel");
    } finally {
      time.mockRestore();
    }
  });
  it("does not claim desktop or cloud checkpoints exist on an owned machine", async () => {
    const fallback = cloud(),
      request = vi.fn(async () => {
        throw new Error("No unsupported RPC");
      });
    const provider = createExecutionComputerProvider({} as Env, {
      cloud: fallback,
      scope: () => ({ botId }),
      targetForOperation: () => target,
      request,
    });
    expect(
      await provider.exec(botId, "desktop", { type: "screenshot" }),
    ).toMatchObject({ status: "failed" });
    expect(await provider.checkpoint(botId)).toMatchObject({
      status: "failed",
    });
    expect(await provider.secureDeployCapabilities?.(botId)).toEqual({
      secureDeploy: false,
    });
    expect(request).not.toHaveBeenCalled();
    expect(fallback.exec).not.toHaveBeenCalled();
  });
  it("delegates cloud targets and waits for genuine device diagnostic results", async () => {
    const fallback = cloud(),
      provider = createExecutionComputerProvider({} as Env, {
        cloud: fallback,
        scope: () => ({ botId }),
        targetForOperation: () => ({ kind: "cloud" }),
      });
    await provider.exec(botId, "cloud-command", {
      type: "exec",
      command: "whoami",
    });
    expect(fallback.exec).toHaveBeenCalledOnce();
    const result = await executeDeviceDiagnostic(
      {} as Env,
      {
        target: target as Extract<ExecutionTarget, { kind: "device" }>,
        botId,
        operationId: "diagnostic",
        action: { type: "diagnostics", target: "system" },
      },
      {
        wait: async () => {},
        request: async (path, input) => ({
          job: input
            ? job("diagnostic")
            : {
                ...job("diagnostic"),
                state: "completed",
                result: {
                  operationId: "diagnostic",
                  status: "completed",
                  output: "real diagnostic snapshot",
                },
              },
        }),
      },
    );
    expect(result).toMatchObject({
      status: "completed",
      output: "real diagnostic snapshot",
    });
  });
});
