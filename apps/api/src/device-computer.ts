import type {
  ComputerAction,
  ComputerProvider,
  ComputerResult,
  ComputerStatus,
  Device,
  DeviceDiagnosticAction,
  DeviceJob,
  ExecutionTarget,
} from "@botspace/contracts";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { createCloudComputerProvider } from "@botspace/computer";
import { deviceRequest } from "./devices";
export interface DeviceComputerOptions {
  scope(): { botId: string; taskId?: string };
  targetForOperation(
    operationId?: string,
  ): Promise<ExecutionTarget> | ExecutionTarget;
  parentJobId?(
    operationId: string,
  ): Promise<string | undefined> | string | undefined;
  nativeOperationIdForOperation?(
    operationId: string,
  ): Promise<string | undefined> | string | undefined;
  approvalForOperation?(
    operationId: string,
  ): Promise<DeviceJob["approval"]> | DeviceJob["approval"];
  cloud?: ComputerProvider;
  request?(path: string, input?: unknown): Promise<unknown>;
  wait?(milliseconds: number): Promise<void>;
}
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const unsupported = (operationId: string, message: string): ComputerResult => ({
  operationId,
  status: "failed",
  error: message,
});
const scopeId = (scope: { botId: string; taskId?: string }) =>
  scope.taskId ?? scope.botId;
function receipt(
  job: DeviceJob,
  operationId: string,
  publicProcessId?: string,
): ComputerResult {
  if (job.result)
    return {
      ...job.result,
      operationId,
      ...(job.result.processId && publicProcessId
        ? { processId: publicProcessId }
        : {}),
    };
  if (job.state === "cancelled")
    return { operationId, status: "cancelled", processId: publicProcessId };
  if (["failed", "interrupted"].includes(job.state))
    return {
      operationId,
      status: job.state as "failed" | "interrupted",
      processId: publicProcessId,
      error:
        "The owned-machine operation could not finish. Inspect its effects before starting another operation.",
    };
  return {
    operationId,
    status: "running",
    ...(publicProcessId ? { processId: publicProcessId } : {}),
    output:
      job.state === "queued"
        ? "Waiting for the owned machine to accept this command."
        : "",
  };
}
/** Exact queue IDs survive caller recovery; owned-machine failures never fall back to cloud execution. */
export function createExecutionComputerProvider(
  env: Env,
  options: DeviceComputerOptions,
): ComputerProvider {
  const cloud = options.cloud ?? createCloudComputerProvider(env.COMPUTER),
    wait = options.wait ?? sleep;
  const remote = async <T>(path: string, input?: unknown): Promise<T> =>
    options.request
      ? ((await options.request(path, input)) as T)
      : deviceRequest<T>(env, path, input);
  async function lookup(
    target: Extract<ExecutionTarget, { kind: "device" }>,
    operationId: string,
  ): Promise<DeviceJob | null> {
    const scope = options.scope();
    return (
      await remote<{ job: DeviceJob | null }>(
        "/operations?deviceId=" +
          encodeURIComponent(target.deviceId) +
          "&scopeId=" +
          encodeURIComponent(scopeId(scope)) +
          "&operationId=" +
          encodeURIComponent(operationId),
      )
    ).job;
  }
  async function observe(job: DeviceJob, deadline: number): Promise<DeviceJob> {
    while (
      ["queued", "delivered", "running"].includes(job.state) &&
      !job.result &&
      Date.now() < deadline
    ) {
      await wait(Math.min(200, Math.max(0, deadline - Date.now())));
      job = (await remote<{ job: DeviceJob }>("/jobs/" + job.id)).job;
    }
    return job;
  }
  async function submit(
    target: Extract<ExecutionTarget, { kind: "device" }>,
    operationId: string,
    action: ComputerAction | DeviceDiagnosticAction,
    publicProcessId?: string,
  ): Promise<ComputerResult> {
    const scope = options.scope(),
      nativeOperationId =
        await options.nativeOperationIdForOperation?.(operationId),
      approval = await options.approvalForOperation?.(operationId),
      parentJobId = await options.parentJobId?.(operationId);
    const { job: submitted } = await remote<{ job: DeviceJob }>("/jobs", {
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      scopeId: scopeId(scope),
      ...scope,
      operationId,
      ...(nativeOperationId ? { nativeOperationId } : {}),
      type: "computer",
      action,
      ...(approval ? { approval } : {}),
      ...(parentJobId ? { parentJobId } : {}),
    });
    const maxWait =
      action.type === "exec" || action.type === "execPoll"
        ? Math.min(20_000, Math.max(0, action.yieldMs ?? 1000))
        : 25_000;
    const job = await observe(submitted, Date.now() + maxWait);
    if (!job.result && action.type !== "exec" && action.type !== "execPoll") {
      await remote("/jobs/" + job.id + "/cancel", {});
      throw new ApiError(
        503,
        "device_operation_pending",
        "This operation is queued or unconfirmed on the owned machine. Retry the same operation ID to observe its result; no action was repeated.",
      );
    }
    return receipt(job, operationId, publicProcessId);
  }
  async function exec(
    botId: string,
    operationId: string,
    action: ComputerAction,
  ): Promise<ComputerResult> {
    const target = await options.targetForOperation(
      ["execPoll", "execCancel"].includes(action.type)
        ? (action as { processId: string }).processId
        : operationId,
    );
    if (target.kind === "cloud") return cloud.exec(botId, operationId, action);
    if (
      [
        "screenshot",
        "click",
        "move",
        "doubleClick",
        "drag",
        "type",
        "key",
        "scroll",
        "navigate",
        "gitClone",
        "gitPush",
        "checkpoint",
      ].includes(action.type)
    )
      return unsupported(
        operationId,
        action.type === "checkpoint"
          ? "Owned-machine files use its local durable filesystem; cloud checkpoints are unavailable."
          : "Desktop and credential-assisted Git actions are unavailable on this owned-machine connection.",
      );
    if (action.type === "execPoll" || action.type === "execCancel") {
      const original = await lookup(target, action.processId);
      if (!original)
        return {
          operationId,
          processId: action.processId,
          status: "interrupted",
          processKnown: false,
          error:
            "The owned-machine process receipt is unavailable. Do not restart its command.",
        };
      if (
        original.result &&
        original.result.status !== "running" &&
        !original.uncertain
      )
        return receipt(original, operationId, action.processId);
      if (action.type === "execCancel") {
        const { job } = await remote<{ job: DeviceJob }>(
          "/jobs/" + original.id + "/cancel",
          {},
        );
        if (job.state === "cancelled" && !job.uncertain)
          return receipt(job, operationId, action.processId);
        return {
          operationId,
          processId: action.processId,
          status: "running",
          output:
            "Cancellation requested; waiting for the owned machine to confirm termination.",
        };
      }
      if (!original.result)
        return receipt(
          await observe(
            original,
            Date.now() + Math.min(20_000, action.yieldMs ?? 1000),
          ),
          operationId,
          action.processId,
        );
      return submit(
        target,
        operationId,
        {
          ...action,
          processId:
            original.result.processId ?? "device-process:" + original.id,
        },
        action.processId,
      );
    }
    return submit(
      target,
      operationId,
      action,
      action.type === "exec" ? operationId : undefined,
    );
  }
  return {
    exec,
    cancel: async (botId, processId) => {
      const target = await options.targetForOperation(processId);
      return target.kind === "cloud"
        ? cloud.cancel(botId, processId)
        : exec(botId, "device-cancel:" + processId, {
            type: "execCancel",
            processId,
          });
    },
    status: async (botId): Promise<ComputerStatus> => {
      const target = await options.targetForOperation();
      if (target.kind === "cloud") return cloud.status(botId);
      try {
        const { device, heldWorkspaces } = await remote<{
          device: Device;
          heldWorkspaces: Array<{ workspaceId: string; jobId: string }>;
        }>("/devices/" + target.deviceId);
        const scope = options.scope(),
          grant = device.grants.find(
            (grant) =>
              grant.botId === scope.botId &&
              grant.workspaceIds.includes(target.workspaceId),
          );
        const capabilities = [
          ...(grant?.permissions.includes("diagnostics")
            ? ["diagnostics"]
            : []),
          ...(grant?.permissions.includes("files.read")
            ? ["readFile", "listFiles"]
            : []),
          ...(grant?.permissions.includes("files.write") ? ["writeFile"] : []),
          ...(grant?.permissions.includes("host.shell")
            ? ["exec", "execPoll", "execCancel"]
            : []),
        ];
        const error = device.revokedAt
          ? {
              code: "device_revoked",
              message: "This owned machine was revoked.",
            }
          : !grant
            ? {
                code: "device_grant_required",
                message: "Grant this bot access to the registered workspace.",
              }
            : !device.online
              ? {
                  code: "device_offline",
                  message:
                    "This owned machine is offline. Accepted work remains queued; uncertain work is never replayed.",
                }
              : heldWorkspaces?.some(
                    (held) => held.workspaceId === target.workspaceId,
                  )
                ? {
                    code: "device_workspace_busy",
                    message:
                      "This workspace has an admitted operation. Its lease is retained until termination is confirmed.",
                  }
                : undefined;
        return {
          id: botId,
          provider: "device",
          deviceId: device.id,
          workspaceId: target.workspaceId,
          state:
            device.online && grant && !device.revokedAt
              ? "running"
              : "unavailable",
          capabilities: device.revokedAt ? [] : capabilities,
          ...(error ? { error } : {}),
        };
      } catch (error) {
        return {
          id: botId,
          provider: "device",
          deviceId: target.deviceId,
          workspaceId: target.workspaceId,
          state: "unavailable",
          capabilities: [],
          error: {
            code: error instanceof ApiError ? error.code : "device_unavailable",
            message:
              error instanceof ApiError
                ? error.message
                : "The owned-machine connection is unavailable.",
          },
        };
      }
    },
    checkpoint: async (botId) => {
      const target = await options.targetForOperation();
      return target.kind === "cloud"
        ? cloud.checkpoint(botId)
        : unsupported(
            crypto.randomUUID(),
            "Owned-machine files use its local durable filesystem; cloud checkpoints are unavailable.",
          );
    },
    controlled: async (botId) => {
      const target = await options.targetForOperation();
      return target.kind === "cloud"
        ? ((await cloud.controlled?.(botId)) ?? false)
        : false;
    },
    secureDeployCapabilities: async (botId, signal) => {
      const target = await options.targetForOperation();
      return target.kind === "cloud"
        ? ((await cloud.secureDeployCapabilities?.(botId, signal)) ?? {
            secureDeploy: false,
          })
        : { secureDeploy: false };
    },
    secureDeploy: async (botId, input) => {
      const target = await options.targetForOperation(input.operationId);
      return target.kind === "cloud" && cloud.secureDeploy
        ? cloud.secureDeploy(botId, input)
        : {
            operationId: input.operationId,
            status: "unavailable",
            code: "secure_deploy_unavailable",
          };
    },
    secureDeployCancel: async (botId, operationId) => {
      const target = await options.targetForOperation(operationId);
      return target.kind === "cloud" && cloud.secureDeployCancel
        ? cloud.secureDeployCancel(botId, operationId)
        : "unknown";
    },
  };
}
export async function executeDeviceDiagnostic(
  env: Env,
  input: {
    target: Extract<ExecutionTarget, { kind: "device" }>;
    botId: string;
    taskId?: string;
    nativeOperationId?: string;
    operationId: string;
    action: DeviceDiagnosticAction;
    parentJobId?: string;
  },
  options?: Pick<DeviceComputerOptions, "request" | "wait">,
): Promise<ComputerResult> {
  const remote = async <T>(path: string, body?: unknown): Promise<T> =>
    options?.request
      ? ((await options.request(path, body)) as T)
      : deviceRequest<T>(env, path, body);
  let { job } = await remote<{ job: DeviceJob }>("/jobs", {
    deviceId: input.target.deviceId,
    workspaceId: input.target.workspaceId,
    botId: input.botId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.nativeOperationId
      ? { nativeOperationId: input.nativeOperationId }
      : {}),
    operationId: input.operationId,
    action: input.action,
    ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
    scopeId: input.taskId ?? input.botId,
    type: "computer",
  });
  const deadline = Date.now() + 25_000;
  while (
    !job.result &&
    ["queued", "delivered", "running"].includes(job.state) &&
    Date.now() < deadline
  ) {
    await (options?.wait ?? sleep)(200);
    job = (await remote<{ job: DeviceJob }>("/jobs/" + job.id)).job;
  }
  if (
    !job.result &&
    !["cancelled", "failed", "interrupted"].includes(job.state)
  )
    throw new ApiError(
      503,
      "device_operation_pending",
      "This diagnostic is queued on the owned machine. Retry the same operation ID to observe it.",
    );
  return receipt(job, input.operationId);
}
