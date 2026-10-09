// Génère icons/{16,48,128}.png à partir d'un SVG, via Chromium.
import { chromium } from 'playwright';
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#2563eb"/>
  <text x="64" y="86" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="64" fill="#fff" text-anchor="middle">Aa</text>
</svg>`;
const browser = await chromium.launch();
for (const s of [16, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: s, height: s } });
  await page.setContent(`<style>body{margin:0;background:transparent}</style>${svg(s)}`);
  await page.screenshot({ path: `icons/${s}.png`, omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icônes générées');
