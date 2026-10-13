// Rebuild the opaque home-screen icons from Timber's existing serif t mark.
// Requires Playwright Chromium (or CONSOLE_CHROMIUM_PATH).
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const output = new URL('../apps/console/public/icons/', import.meta.url);
const browser = await chromium.launch({headless: true,
  ...(process.env.CONSOLE_CHROMIUM_PATH ? {executablePath: process.env.CONSOLE_CHROMIUM_PATH} : {}),
  ...(process.env.CONSOLE_CHROMIUM_ARGS ? {args: JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)} : {}),
});
try {
  await mkdir(output, {recursive: true});
  const page = await browser.newPage();
  for (const [name, size] of [['apple-touch-icon', 180], ['icon-192', 192], ['icon-512', 512], ['icon-maskable-512', 512]]) {
    const png = await page.evaluate(size => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#111214'; ctx.fillRect(0, 0, size, size);
      // Keep the entire glyph inside the central maskable safe zone (80% circle).
      ctx.translate(size / 2, size / 2); ctx.rotate(-8 * Math.PI / 180);
      ctx.fillStyle = '#f3f3f5'; ctx.font = `600 ${size * 0.72}px Georgia, serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      const metrics = ctx.measureText('t');
      ctx.fillText('t', 0, (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
      return canvas.toDataURL('image/png').split(',')[1];
    }, size);
    await writeFile(new URL(`${name}.png`, output), Buffer.from(png, 'base64'));
  }
} finally { await browser.close(); }
