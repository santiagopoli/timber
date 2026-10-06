import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { ComputerAction } from '@botspace/contracts';
import type { PendingApproval, RuntimeTools } from './types.js';

type Context = Parameters<ToolExecutionApi['agent']>[0];
export interface ToolBridge {
  tools: RuntimeTools;
  imageInputSupported?(): Promise<boolean>;
  operationForCall(api: ToolExecutionApi, context: Context): Promise<string>;
  consume(runOperationId: string, kind: 'tool', itemId: string): void;
  paused?(runOperationId: string): PendingApproval | undefined;
  pause?(runOperationId: string, approval: PendingApproval): void;
}

/** Keep admitted journal identities stable; opaque provider IDs need a bounded wire identity. */
export async function computerToolOperationId(taskId: string, callId: string): Promise<string> {
  const legacyId = `pi-tool:${taskId}:${callId}`;
  if (legacyId.length <= 160 && !/[^A-Za-z0-9:_.-]/.test(legacyId)) return legacyId;
  // JSON preserves tuple boundaries and Unicode code units without lossy sanitization.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([taskId, callId])));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  // Separate namespace: no already-valid pi-tool: identity can equal a hash identity.
  return `pi-tool-sha256:${hex}`;
}

export async function executeComputerTool(
  bridge: ToolBridge,
  action: ComputerAction,
  api: ToolExecutionApi,
  context: Context,
): Promise<ToolExecutionResult> {
  if (action.type === 'screenshot' && bridge.imageInputSupported && !(await bridge.imageInputSupported())) {
    return { content: [{ type: 'text', text: 'The configured model does not accept screenshot images. Select a vision-capable model to use visual computer tools.' }], isError: true };
  }
  const runOperationId = await bridge.operationForCall(api, context);
  const operationId = await computerToolOperationId(String(api.taskId), api.callId);
  const paused = bridge.paused?.(runOperationId);
  if (paused) return { content: [{ type: 'text', text: JSON.stringify(paused) }], control: { terminate: true } };
  try {
    bridge.consume(runOperationId, 'tool', operationId);
  } catch {
    return {
      content: [{ type: 'text', text: 'This run reached its tool budget. Ask the user to continue.' }],
      isError: true,
      control: { terminate: true },
    };
  }
  const signal = context.abortSignal ?? new AbortController().signal;
  signal.throwIfAborted();
  const result = await bridge.tools.execute({ operationId, runOperationId, action, signal });
  if (result.status === 'pending_approval') {
    bridge.pause?.(runOperationId, result);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      // Native Pi durable termination: no unbounded promise and no repeated model requests.
      control: { terminate: true },
    };
  }
  const content: NonNullable<ToolExecutionResult['content']> = [{ type: 'text', text: JSON.stringify(result) }];
  if (action.type === 'screenshot' && result.status === 'completed' && result.artifactId && bridge.tools.readImage) {
    const image = await bridge.tools.readImage(result.artifactId);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) || image.data.length > 8_000_000) {
      throw new Error('Screenshot exceeds supported image limits');
    }
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  }
  return { content, isError: result.status !== 'completed' };
}

export function computerTools(bridge: ToolBridge) {
  const path = Type.String({ minLength: 1, maxLength: 1024, description: 'Path within /workspace.' });
  return [
    defineTool({ name: 'read_file', description: 'Read a text file in the bot workspace.', replay: 'safe',
      parameters: Type.Object({ path }), execute: ({ path }, api, context) => executeComputerTool(bridge, { type: 'readFile', path }, api, context) }),
    defineTool({ name: 'list_files', description: 'List files in the bot workspace.', replay: 'safe',
      parameters: Type.Object({ path: Type.Optional(path) }), execute: ({ path }, api, context) => executeComputerTool(bridge, { type: 'listFiles', ...(path ? { path } : {}) }, api, context) }),
    defineTool({ name: 'write_file', description: 'Write a complete text file in /workspace. Host approval policy applies.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ path, content: Type.String({ maxLength: 200000 }) }), execute: ({ path, content }, api, context) => executeComputerTool(bridge, { type: 'writeFile', path, content }, api, context) }),
    defineTool({ name: 'exec', description: 'Execute a shell command in the reusable computer. Host approval policy applies. Never place credentials in commands.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 10000 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000 })) }),
      execute: ({ command, timeoutMs }, api, context) => executeComputerTool(bridge, { type: 'exec', command, ...(timeoutMs ? { timeoutMs } : {}) }, api, context) }),
    defineTool({ name: 'browser_navigate', description: 'Navigate the computer Chromium browser to an HTTP(S) URL. Host approval policy applies.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 4096 }) }), execute: ({ url }, api, context) => executeComputerTool(bridge, { type: 'navigate', url }, api, context) }),
    defineTool({ name: 'desktop_screenshot', description: 'Capture the actual desktop. Returns image pixels and an artifact reference.', replay: 'safe', executionMode: 'sequential',
      parameters: Type.Object({}), execute: (_args, api, context) => executeComputerTool(bridge, { type: 'screenshot' }, api, context) }),
    defineTool({ name: 'desktop_click', description: 'Click a desktop pixel coordinate. Host approval policy applies.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1279 }), y: Type.Integer({ minimum: 0, maximum: 799 }), button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])) }),
      execute: ({ x, y, button }, api, context) => executeComputerTool(bridge, { type: 'click', x, y, ...(button ? { button } : {}) }, api, context) }),
    defineTool({ name: 'desktop_type', description: 'Type text into the focused desktop control. Host approval policy applies. Do not use this to ask the user to paste secrets into chat.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ text: Type.String({ maxLength: 10000 }) }), execute: ({ text }, api, context) => executeComputerTool(bridge, { type: 'type', text }, api, context) }),
    defineTool({ name: 'desktop_key', description: 'Press a key or key chord in the desktop. Host approval policy applies.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ key: Type.String({ minLength: 1, maxLength: 100 }) }), execute: ({ key }, api, context) => executeComputerTool(bridge, { type: 'key', key }, api, context) }),
    defineTool({ name: 'desktop_scroll', description: 'Scroll the desktop. Host approval policy applies.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ direction: Type.Union([Type.Literal('up'), Type.Literal('down')]), amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }),
      execute: ({ direction, amount }, api, context) => executeComputerTool(bridge, { type: 'scroll', direction, ...(amount ? { amount } : {}) }, api, context) }),
    defineTool({ name: 'checkpoint', description: 'Persist a consistent workspace checkpoint to durable storage.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({}), execute: (_args, api, context) => executeComputerTool(bridge, { type: 'checkpoint' }, api, context) }),
  ];
}
