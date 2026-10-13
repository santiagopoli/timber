import {expect, it} from 'vitest';
import type {Message, ToolResultMessage} from '@earendil-works/pi-ai';
import {previewToolOutputs} from '../src/tool-context.js';

it('keeps status, errors, process identity and both ends of output without changing the retained message', () => {
  const result = {status:'failed', exitCode:1, error:'Build failed', processId:'retained-process', output:'START'+'x'.repeat(9000)+'MIDDLE'+'y'.repeat(9000)+'END'};
  const message: ToolResultMessage = {role:'toolResult', toolCallId:'large-call', toolName:'exec', timestamp:123, isError:true, content:[{type:'text', text:JSON.stringify(result)}]};
  const original = JSON.stringify(message);
  const output = previewToolOutputs([message])[0] as ToolResultMessage;
  const preview = JSON.parse((output.content[0] as {text:string}).text);
  expect(preview).toMatchObject({status:'failed', exitCode:1, error:'Build failed', processId:'retained-process', outputPreview:{totalCharacters:result.output.length,toolCallId:'large-call',timestamp:123}});
  expect(preview.output).toContain('START');expect(preview.output).toContain('END');expect(preview.output).not.toContain('MIDDLE');
  expect(JSON.stringify(message)).toBe(original);
});
it('leaves host tool schemas, images, malformed text and short results intact', () => {
  const messages: Message[] = [
    {role:'toolResult', toolCallId:'catalog', toolName:'list_tools', timestamp:1, isError:false, content:[{type:'text',text:JSON.stringify({output:'x'.repeat(18000)})}]},
    {role:'toolResult', toolCallId:'read', toolName:'read_file', timestamp:1, isError:false, content:[{type:'image',data:'aW1hZ2U=',mimeType:'image/png'},{type:'text',text:'not JSON'},{type:'text',text:'{"output":"short"}'}]},
  ];
  expect(previewToolOutputs(messages)).toEqual(messages);
});
