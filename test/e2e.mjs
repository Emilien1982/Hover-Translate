// Test de bout en bout : charge l'extension dans Chromium, survole des mots
// et vérifie le contenu réel de la pop-up. Google Translate est appelé pour de vrai ;
// l'API LLM est remplacée par un serveur local qui imite le streaming SSE d'Anthropic
// (via le réglage « URL de l'API »), pour tester sans clé ni coût.
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test/output');
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// ---------- Serveur local : page de test + faux LLM ----------

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test</title>
<style>body{font:18px/1.6 Georgia,serif;max-width:640px;margin:60px auto;padding:0 20px}</style></head><body>
<h1>River notes</h1>
<p id="p1">We had a lovely picnic on the bank of the river, watching the boats drift by.</p>
<p id="p2">Later she went to the bank to deposit her salary before it closed.</p>
<p id="p3">The children were running happily across the meadow.</p>
<p id="p4" lang="fr">Il a acheté du pain frais ce matin à la boulangerie du quartier.</p>
</body></html>`;

const llmRequests = [];
const CHUNKS = ['ri', 've\n', 'nom · bank · anglais\n', '1. rive, berge — bord d\'un cours d\'eau\n',
  '   « the river bank » → la rive du fleuve\n', '2. banque — établissement financier\n'];

const server = http.createServer(async (req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.url === '/v1/messages') {
    let body = '';
    for await (const c of req) body += c;
    llmRequests.push({ headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
    const sse = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    sse('message_start', { message: {} });
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const text of CHUNKS) {
      await new Promise((r) => setTimeout(r, 80));
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    }
    sse('message_stop', {});
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- Chromium avec l'extension ----------

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 900, height: 600 },
  locale: 'fr-FR',
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--lang=fr-FR'],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const setSettings = (s) => sw.evaluate((s) => chrome.storage.local.set(s), s);

const page = await ctx.newPage();
await page.goto(base);
await page.waitForTimeout(300);
console.log('  (détecteur de langue de Chrome dans ce Chromium :',
  await page.evaluate(async () => ('LanguageDetector' in self ? LanguageDetector.availability() : 'absent')), ')');

// Centre de la n-ième occurrence d'un mot dans un paragraphe.
async function wordCenter(sel, word) {
  return page.evaluate(([sel, word]) => {
    const node = document.querySelector(sel).firstChild;
    const i = node.data.indexOf(word);
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + word.length);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, [sel, word]);
}

const popup = () => page.evaluate(() => {
  const host = document.querySelector('hover-translate-popup');
  if (!host) return null;
  const q = (s) => host.shadowRoot.querySelector(s)?.textContent ?? null;
  return { title: q('.title'), word: q('.word'), dict: q('.dict'), footer: q('.footer') };
});

async function waitPopup(pred, timeout = 4000) {
  const t0 = Date.now();
  let p;
  while (Date.now() - t0 < timeout) {
    p = await popup();
    if (pred(p)) return p;
    await page.waitForTimeout(25);
  }
  return p;
}

// 1. Survol + Alt maintenu, moteur Google + faux Claude
await setSettings({ provider: 'anthropic', anthropicKey: 'test-key', baseUrl: base, targetLang: 'auto', holdKey: 'Alt', googleQuick: true });
let pt = await wordCenter('#p1', 'bank');
await page.mouse.move(pt.x, pt.y);
await page.waitForTimeout(150);
check((await popup()) === null, 'pas de pop-up sans la touche Alt');

const t0 = Date.now();
await page.keyboard.down('Alt');
let p = await waitPopup((p) => p?.title && !p.title.trim().match(/^\s*$/));
check(!!p, 'pop-up affichée avec Alt', `titre initial « ${p?.title} » après ${Date.now() - t0} ms`);
p = await waitPopup((p) => p?.dict?.includes('banque — établissement'));
check(p?.title === 'rive', 'titre = traduction contextuelle du LLM', `« ${p?.title} »`);
check(p?.word?.startsWith('bank'), 'mot source affiché', p?.word);
check(p?.dict?.includes('« the river bank »'), 'entrée de dictionnaire rendue');
await page.screenshot({ path: path.join(outDir, '1-popup-llm.png') });

const req = llmRequests.at(-1);
check(req?.headers['x-api-key'] === 'test-key', 'clé API envoyée dans x-api-key');
check(req?.headers['anthropic-dangerous-direct-browser-access'] === 'true', 'en-tête accès direct navigateur');
check(req?.body.model === 'claude-haiku-5-5' && req?.body.stream === true, 'modèle Haiku 5.5 en streaming');
check(req?.body.messages[0].content.includes('picnic on the bank of the river'), 'phrase de contexte transmise', req?.body.messages[0].content.replace(/\n/g, ' | '));
check(req?.body.system.includes('de : anglais, vers : français'), 'langue « automatique » = français (navigateur), source anglaise transmise', req?.body.system.split('\n')[0]);

// 2. Relâcher Alt : la pop-up reste lisible ; s'éloigner la ferme
await page.keyboard.up('Alt');
await page.mouse.move(pt.x + 5, pt.y + 2);
await page.waitForTimeout(100);
check((await popup()) !== null, 'pop-up conservée après relâchement de Alt');
await page.mouse.move(20, 580);
await page.waitForTimeout(100);
check((await popup()) === null, 'pop-up fermée en s\'éloignant');

// 3. Autre phrase : le contexte change, le cache ne doit pas servir l'ancien sens
pt = await wordCenter('#p2', 'bank');
await page.mouse.move(pt.x, pt.y);
await page.keyboard.down('Alt');
await waitPopup((p) => p?.footer && !p.footer.includes('…'));
check(llmRequests.at(-1).body.messages[0].content.includes('deposit her salary'), 'nouveau contexte → nouvelle requête LLM');
await page.keyboard.up('Alt');
await page.mouse.move(20, 580);

// 4. Même mot, même phrase : servi depuis le cache
pt = await wordCenter('#p1', 'bank');
const before = llmRequests.length;
await page.mouse.move(pt.x, pt.y);
await page.keyboard.down('Alt');
p = await waitPopup((p) => p?.footer === 'cache', 1500);
check(p?.footer === 'cache' && llmRequests.length === before, 'second survol servi par le cache', `footer « ${p?.footer} »`);
await page.keyboard.up('Alt');
await page.mouse.move(20, 580);

// 5. Survol de la marge (pas sur un mot) : aucune pop-up
const margin = await page.evaluate(() => {
  const b = document.querySelector('#p3').getBoundingClientRect();
  return { x: b.right + 60, y: b.top + 10 };
});
await page.mouse.move(margin.x, margin.y);
await page.keyboard.down('Alt');
await page.waitForTimeout(250);
check((await popup()) === null, 'aucune pop-up hors d\'un mot');
await page.keyboard.up('Alt');

// 6. Mode bascule (le raccourci envoie « toggle » à l'onglet) : survol sans touche
await sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true });
  await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
});
await setSettings({ provider: 'none' });
pt = await wordCenter('#p3', 'meadow');
await page.mouse.move(pt.x, pt.y);
p = await waitPopup((p) => p?.dict && p.footer?.startsWith('Google'));
check(!!p?.title && p.title !== 'meadow' && !p.dict.includes('Ajoutez'), 'mode bascule + Google seul, sans invite de clé', `« ${p?.title} » / ${p?.dict} / ${p?.footer}`);
await page.screenshot({ path: path.join(outDir, '2-popup-google.png') });
await page.keyboard.press('Escape');
check((await popup()) === null, 'Échap ferme et désactive');

// 6b. Phrase française, destination française : définition au lieu de traduction (Google seul)
pt = await wordCenter('#p4', 'pain');
await page.mouse.move(pt.x, pt.y);
await page.keyboard.down('Alt');
p = await waitPopup((p) => p?.dict?.includes('farine'));
check(p?.title === 'pain' && p?.word?.startsWith('définition') && p?.dict?.includes('farine'),
  'même langue → définition en français (Google)', `« ${p?.title} » / ${p?.word} / ${p?.dict?.slice(0, 80)}…`);
await page.screenshot({ path: path.join(outDir, '2b-definition-google.png') });
await page.keyboard.up('Alt');
await page.mouse.move(20, 580);

// 6c. Même cas avec le LLM : invite « dictionnaire unilingue »
await setSettings({ provider: 'anthropic', anthropicKey: 'test-key', baseUrl: base });
pt = await wordCenter('#p4', 'boulangerie');
await page.mouse.move(pt.x, pt.y);
await page.keyboard.down('Alt');
await waitPopup((p) => p?.footer && !p.footer.includes('…'));
check(llmRequests.at(-1).body.system.startsWith('Tu es un dictionnaire unilingue instantané (français)'),
  'même langue → invite de définition envoyée au LLM', llmRequests.at(-1).body.system.split('\n')[0]);
await page.keyboard.up('Alt');
await page.mouse.move(20, 580);

// 6d. Destination forcée (allemand) : la phrase française est traduite
await setSettings({ provider: 'none', targetLang: 'de' });
pt = await wordCenter('#p4', 'pain');
await page.mouse.move(pt.x, pt.y);
await page.keyboard.down('Alt');
p = await waitPopup((p) => p?.footer?.startsWith('Google'));
check(p?.title?.toLowerCase() === 'brot', 'destination allemande : « pain » (fr) → Brot', `« ${p?.title} »`);
await page.keyboard.up('Alt');
await page.mouse.move(20, 580);
await setSettings({ targetLang: 'auto' });

// 7. Erreur API lisible (clé refusée)
await setSettings({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', anthropicKey: 'sk-ant-invalide' });
pt = await wordCenter('#p3', 'children');
await page.mouse.move(pt.x, pt.y);
await page.keyboard.down('Alt');
p = await waitPopup((p) => p?.dict?.includes('Claude :'), 6000);
check(p?.dict?.includes('HTTP 401'), 'vraie API Anthropic : erreur 401 affichée avec une clé invalide', p?.dict);
await page.screenshot({ path: path.join(outDir, '3-popup-erreur.png') });
await page.keyboard.up('Alt');

// 8. Page d'options
const extId = sw.url().split('/')[2];
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/src/options.html`);
await opt.waitForTimeout(200);
check(await opt.locator('#anthropicKey').inputValue() === 'sk-ant-invalide', 'options : réglages relus depuis le stockage');
const langs = await opt.locator('#targetLang option').allTextContents();
check(langs[0] === 'Automatique — langue du navigateur (français)' && langs.length > 40 && langs.includes('allemand — Deutsch'),
  'options : liste des langues', `${langs.length} options, ex. « ${langs[0]} », « ${langs[1]} »`);
await opt.screenshot({ path: path.join(outDir, '4-options.png'), fullPage: true });

await ctx.close();
server.close();
console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
process.exit(failures ? 1 : 0);
