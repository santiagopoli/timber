import {after} from 'node:test';
import {chromium} from 'playwright';

// Each test file owns one browser process. Tests must create and close their own
// contexts, so cookies, storage, routes and pages never cross scenario boundaries.
export function createConsoleBrowser() {
  let opening;
  after(async () => {if (opening) await (await opening).close();});
  return () => opening ??= chromium.launch({headless: true,
    ...(process.env.CONSOLE_CHROMIUM_PATH ? {executablePath: process.env.CONSOLE_CHROMIUM_PATH} : {}),
    ...(process.env.CONSOLE_CHROMIUM_ARGS ? {args: JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)} : {}),
  });
}
