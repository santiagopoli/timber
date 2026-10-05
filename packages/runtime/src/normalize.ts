import type { EntryRecord } from '@earendil-works/pi-durable';
import type { RuntimeMessage } from './types.js';

/** Do not expose provider-specific payloads or private reasoning in the app. */
export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part): part is { type: 'text'; text: string } =>
    !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string',
  ).map(part => part.text).join('');
}
export function normalizeEntries(entries: readonly EntryRecord[]): RuntimeMessage[] {
  return entries.flatMap(entry => (entry.model ?? []).flatMap((message, index) => {
    const role = message.role === 'toolResult' ? 'tool' : message.role;
    if (!['user', 'assistant', 'tool', 'system'].includes(role)) return [];
    const text = textContent(message.content);
    if (!text) return [];
    const timestamp = 'timestamp' in message ? message.timestamp : undefined;
    return [{
      id: `pi:${String(entry.id)}:${index}`,
      role: role as RuntimeMessage['role'],
      text,
      ...(typeof timestamp === 'number' && Number.isFinite(timestamp)
        ? { createdAt: new Date(timestamp).toISOString() } : {}),
    }];
  }));
}
