import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { ComputerAction } from '@botspace/contracts';
import type { RuntimeHostToolRequest, RuntimePause, RuntimeToolResult, RuntimeTools } from './types.js';

type Context = Parameters<ToolExecutionApi['agent']>[0];
export interface ToolBridge {
  tools: RuntimeTools;
  imageInputSupported?(): Promise<boolean>;
  operationForCall(api: ToolExecutionApi, context: Context): Promise<string>;
  consume(runOperationId: string, kind: 'tool', itemId: string): void;
  paused?(runOperationId: string): RuntimePause | undefined;
  pause?(runOperationId: string, pending: RuntimePause): void;
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

async function executeBridgeTool(
  bridge: ToolBridge,
  api: ToolExecutionApi,
  context: Context,
  dispatch: (request: Omit<RuntimeHostToolRequest, 'name' | 'arguments'>) => Promise<RuntimeToolResult>,
  render?: (result: Exclude<RuntimeToolResult, RuntimePause>) => Promise<NonNullable<ToolExecutionResult['content']>>,
): Promise<ToolExecutionResult> {
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
      // Let the model explain this result; terminating here would settle on its
      // previous tool-call commentary without ever producing a final answer.
    };
  }
  const signal = context.abortSignal ?? new AbortController().signal;
  signal.throwIfAborted();
  const result = await dispatch({ operationId, runOperationId, toolCallId: api.callId, signal });
  if (result.status === 'pending_approval' || result.status === 'pending_connection') {
    bridge.pause?.(runOperationId, result);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      // Native Pi durable termination: no unbounded promise and no repeated model requests.
      control: { terminate: true },
    };
  }
  const content: NonNullable<ToolExecutionResult['content']> = [{ type: 'text', text: JSON.stringify(result) }];
  if (render) content.push(...await render(result));
  return { content, isError: result.status !== 'completed' };
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
  return executeBridgeTool(bridge, api, context, request => bridge.tools.execute({ ...request, action }), async result => {
    if (action.type !== 'screenshot' || result.status !== 'completed' || !result.artifactId || !bridge.tools.readImage) return [];
    const image = await bridge.tools.readImage(result.artifactId);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) || image.data.length > 8_000_000) {
      throw new Error('Screenshot exceeds supported image limits');
    }
    return [{ type: 'image', data: image.data, mimeType: image.mimeType }];
  });
}

export async function executeHostTool(
  bridge: ToolBridge,
  input: Pick<RuntimeHostToolRequest, 'name' | 'arguments'>,
  api: ToolExecutionApi,
  context: Context,
): Promise<ToolExecutionResult> {
  return executeBridgeTool(bridge, api, context, request => {
    if (!bridge.tools.call) return Promise.resolve({ operationId: request.operationId, status: 'failed', error: 'Connected tools are not configured for this bot.' });
    // The host validates the current schema, connection and scope on every call.
    return bridge.tools.call({ ...request, ...input });
  });
}

/** Keep service integrations and skills independent of the agent engine. */
export function hostTools(bridge: ToolBridge) {
  if (!bridge.tools.catalog || !bridge.tools.call) return [];
  return [
    defineTool({ name: 'list_tools', description: 'Discover available connected-service tools, workspace app tools, and skills. Returns names, descriptions and input schemas; does not grant permissions or start the computer.', replay: 'safe',
      parameters: Type.Object({}), execute: (_args, api, context) => executeBridgeTool(bridge, api, context, async request => ({
        operationId: request.operationId, status: 'completed', output: JSON.stringify(await bridge.tools.catalog!()),
      })) }),
    defineTool({ name: 'call_tool', description: 'Call a host tool from list_tools using its exact input schema. Connection and repository permissions are enforced by the host. A pending_connection or pending_approval result pauses this run until the host resumes it.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), arguments: Type.Record(Type.String(), Type.Unknown()) }),
      execute: (input, api, context) => executeHostTool(bridge, input, api, context) }),
  ];
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
    defineTool({ name: 'exec', description: 'Run a finite shell command in the reusable computer; the default and maximum timeout are 120 seconds. A timeout kills its process group. Start long-running app servers detached with stdin/stdout/stderr redirected and logs outside /workspace, then check readiness separately. Host approval policy applies. Never place credentials in commands.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 10000 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120000, default: 120000 })) }),
      execute: ({ command, timeoutMs }, api, context) => executeComputerTool(bridge, { type: 'exec', command, timeoutMs: timeoutMs ?? 120000 }, api, context) }),
    defineTool({ name: 'browser_navigate', description: 'Navigate the computer Chromium browser to an HTTP(S) URL. Host approval policy applies.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 4096 }) }), execute: ({ url }, api, context) => executeComputerTool(bridge, { type: 'navigate', url }, api, context) }),
    defineTool({ name: 'desktop_screenshot', description: 'Capture the actual desktop. Returns image pixels and an artifact reference.', replay: 'safe', executionMode: 'sequential',
      parameters: Type.Object({}), execute: (_args, api, context) => executeComputerTool(bridge, { type: 'screenshot' }, api, context) }),
    defineTool({ name: 'desktop_click', description: 'Click a desktop pixel coordinate. Host approval policy applies.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1279 }), y: Type.Integer({ minimum: 0, maximum: 799 }), button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])) }),
      execute: ({ x, y, button }, api, context) => executeComputerTool(bridge, { type: 'click', x, y, ...(button ? { button } : {}) }, api, context) }),
    defineTool({ name: 'desktop_move', description: 'Move the pointer to a desktop pixel coordinate without clicking, for example to hover over a menu or tooltip. Coordinates refer to the full 1280×800 desktop screenshot. Host approval policy applies.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1279 }), y: Type.Integer({ minimum: 0, maximum: 799 }) }),
      execute: ({ x, y }, api, context) => executeComputerTool(bridge, { type: 'move', x, y }, api, context) }),
    defineTool({ name: 'desktop_double_click', description: 'Double-click a desktop pixel coordinate. Defaults to the left mouse button. Host approval policy applies.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1279 }), y: Type.Integer({ minimum: 0, maximum: 799 }), button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])) }),
      execute: ({ x, y, button }, api, context) => executeComputerTool(bridge, { type: 'doubleClick', x, y, ...(button ? { button } : {}) }, api, context) }),
    defineTool({ name: 'desktop_drag', description: 'Drag the pointer from one desktop pixel coordinate to another while holding a mouse button, then release it. Use for selecting text, moving windows or dragging objects. Defaults to the left button and 500 ms. Coordinates refer to the full 1280×800 desktop screenshot. Host approval policy applies.', replay: 'unsafe', executionMode: 'sequential',
      parameters: Type.Object({ fromX: Type.Integer({ minimum: 0, maximum: 1279 }), fromY: Type.Integer({ minimum: 0, maximum: 799 }), toX: Type.Integer({ minimum: 0, maximum: 1279 }), toY: Type.Integer({ minimum: 0, maximum: 799 }), button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])), durationMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 2000, default: 500 })) }),
      execute: ({ fromX, fromY, toX, toY, button, durationMs }, api, context) => executeComputerTool(bridge, { type: 'drag', fromX, fromY, toX, toY, ...(button ? { button } : {}), ...(durationMs === undefined ? {} : { durationMs }) }, api, context) }),
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
