import { readFile } from 'node:fs/promises';

export const clientConfigUrl = new URL('../.local/client.json', import.meta.url);
export async function readClientConfig() {
  try {
    const value = JSON.parse(await readFile(clientConfigUrl, 'utf8'));
    return { apiUrl: typeof value.apiUrl === 'string' ? value.apiUrl : undefined,
      apiToken: typeof value.apiToken === 'string' ? value.apiToken : undefined };
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Cannot read .local/client.json. Fix or remove this local configuration.');
  }
}
