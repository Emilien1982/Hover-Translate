// Test de bout en bout : charge l'extension dans Chromium, survole des mots
// et vérifie le contenu réel de la pop-up et des requêtes envoyées.
// Les fournisseurs d'IA sont imités par un serveur local (streaming SSE au format
// OpenAI et Anthropic) ; une dernière série appelle les vrais fournisseurs avec
// une clé invalide pour prouver que l'extension les atteint.
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

// ---------- Serveur local : page de test + faux fournisseurs ----------

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test</title>
<style>body{font:18px/1.6 Georgia,serif;max-width:640px;margin:60px auto;padding:0 20px}</style></head><body>
<h1>River notes</h1>
<p id="p1">We had a lovely picnic on the bank of the river, watching the boats drift by.</p>
<p id="p2">Later she went to the bank to deposit her salary before it closed.</p>
<p id="p3">The children were running happily across the meadow.</p>
<p id="p4" lang="fr">Il a acheté du pain frais ce matin à la boulangerie du quartier.</p>
</body></html>`;

const requests = [];
const mock = { rejectSpeedParams: false };
const CHUNKS = ['ri', 've\n', 'nom · bank · anglais\n', "1. rive, berge — bord d'un cours d'eau\n",
  '   « the river bank » → la rive du fleuve\n', '2. banque — établissement financier\n'];
const MODELS = ['models/embedding-001', 'models/gemini-2.5-flash', 'models/gemini-3.5-flash-lite'];

const server = http.createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/v1/models') {
    return res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      .end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
  }
  if (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages') {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push({ path: url.pathname, headers: req.headers, body });
    const auth = req.headers.authorization ?? req.headers['x-api-key'] ?? '';
    if (auth.includes('bad')) return res.writeHead(401, { ...cors, 'content-type': 'application/json' }).end('{"error":{"message":"invalid key"}}');
    if (mock.rejectSpeedParams && (body.reasoning_effort || body.reasoning)) {
      return res.writeHead(400, { ...cors, 'content-type': 'application/json' }).end('{"error":{"message":"unsupported parameter"}}');
    }
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
    for (const text of CHUNKS) {
      await new Promise((r) => setTimeout(r, 60));
      const ev = url.pathname === '/v1/messages'
        ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
        : { choices: [{ index: 0, delta: { content: text } }] };
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
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
const useProvider = (provider, key = 'k-test', model) =>
  setSettings({ provider, keys: { [provider]: key }, models: model ? { [provider]: model } : {}, apiBaseOverride: `${base}/v1` });

// L'onglet d'options s'ouvre tout seul à l'installation (aucun fournisseur configuré).
await new Promise((r) => setTimeout(r, 500));
check(ctx.pages().some((pg) => pg.url().endsWith('/src/options.html')), "installation : la page de réglages s'ouvre");

const page = await ctx.newPage();
await page.goto(base);
await page.waitForTimeout(300);

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
  return { title: q('.title:not(.skeleton)'), word: q('.word'), dict: q('.dict'), footer: q('.footer'), button: q('button') };
});

// Attend une condition en enregistrant tous les titres affichés entre-temps.
async function waitPopup(pred, timeout = 4000) {
  const t0 = Date.now();
  const titles = new Set();
  let p;
  while (Date.now() - t0 < timeout) {
    p = await popup();
    if (p?.title) titles.add(p.title);
    if (pred(p)) break;
    await page.waitForTimeout(15);
  }
  return Object.assign(p ?? {}, { titles: [...titles] });
}

async function hover(sel, word) {
  const pt = await wordCenter(sel, word);
  await page.mouse.move(pt.x, pt.y);
  await page.keyboard.down('Alt');
  return pt;
}
async function leave() {
  await page.keyboard.up('Alt');
  await page.mouse.move(20, 580);
  await page.waitForTimeout(50);
}
const done = (p) => /ms$|cache$/.test(p?.footer ?? '') || /refusés|Quota|introuvable/.test(p?.dict ?? '');

// 1. Aucun fournisseur : invitation à configurer
let pt = await wordCenter('#p1', 'bank');
await page.mouse.move(pt.x, pt.y);
await page.waitForTimeout(150);
check((await popup()) === null, 'pas de pop-up sans la touche Alt');
await page.keyboard.down('Alt');
let p = await waitPopup((p) => p?.button);
check(p?.button === 'Configurer' && p?.dict?.includes('Connectez un fournisseur'), 'sans fournisseur : invitation « Configurer »', p?.dict);
await page.screenshot({ path: path.join(outDir, '0-sans-fournisseur.png') });
await leave();

// 2. Gemini (API compatible OpenAI) : jamais de titre provisoire
await useProvider('gemini');
await setSettings({ targetLang: 'auto', holdKey: 'Alt' });
await hover('#p1', 'bank');
p = await waitPopup((p) => p?.dict?.includes('banque — établissement'));
check(p?.title === 'rive' && p.titles.length === 1, 'titre = 1re ligne du LLM, sans titre provisoire', `titres vus : ${JSON.stringify(p?.titles)}`);
check(p?.word?.startsWith('bank') && p.word.endsWith('EN'), 'mot source + langue détectée', p?.word);
check(p?.dict?.includes('« the river bank »'), 'entrée de dictionnaire rendue');
await waitPopup(done);
await page.screenshot({ path: path.join(outDir, '1-popup.png') });
let r = requests.at(-1);
check(r?.path === '/v1/chat/completions' && r.headers.authorization === 'Bearer k-test', 'Gemini : route chat/completions + Bearer');
check(r?.body.model === 'gemini-3.5-flash-lite' && r.body.stream && r.body.reasoning_effort === 'none', 'Gemini : modèle par défaut, streaming, réflexion coupée', `${r?.body.model} / ${r?.body.reasoning_effort}`);
check(r?.body.messages[0].content.includes('de : anglais, vers : français'), 'langue automatique = français, source anglaise', r?.body.messages[0].content.split('\n')[0]);
check(r?.body.messages[1].content.includes('picnic on the bank of the river'), 'phrase de contexte transmise');

// 3. Pop-up conservée après relâchement, fermée en s'éloignant
await page.keyboard.up('Alt');
pt = await wordCenter('#p1', 'bank');
await page.mouse.move(pt.x + 4, pt.y + 2);
await page.waitForTimeout(80);
check((await popup()) !== null, 'pop-up conservée après relâchement de Alt');
await leave();
check((await popup()) === null, "pop-up fermée en s'éloignant");

// 4. Cache, puis nouveau contexte
let n = requests.length;
await hover('#p1', 'bank');
p = await waitPopup((p) => p?.footer?.includes('cache'), 1500);
check(p?.footer === 'Google Gemini · cache' && requests.length === n, 'second survol servi par le cache', p?.footer);
await leave();
await hover('#p2', 'bank');
await waitPopup(done);
check(requests.at(-1).body.messages[1].content.includes('deposit her salary'), 'nouveau contexte → nouvelle requête');
await leave();

// 5. Même langue que la destination : consigne de définition
await hover('#p4', 'pain');
p = await waitPopup(done);
check(requests.at(-1).body.messages[0].content.startsWith('Tu es un dictionnaire unilingue instantané (français)'), 'phrase française → définition, pas traduction');
check(p?.word?.startsWith('pain · définition'), 'pop-up marquée « définition »', p?.word);
await leave();

// 6. OpenAI : paramètres de vitesse refusés → nouvel essai sans
await useProvider('openai');
mock.rejectSpeedParams = true;
n = requests.length;
await hover('#p3', 'meadow');
p = await waitPopup(done);
const tries = requests.slice(n);
check(tries.length === 2 && tries[0].body.reasoning_effort === 'minimal' && !('reasoning_effort' in tries[1].body) && p?.title === 'rive',
  'OpenAI : réflexion refusée (400) → nouvel essai sans, réussi', tries.map((t) => t.body.reasoning_effort ?? '—').join(' puis '));
check(tries[0]?.body.max_completion_tokens && !('max_tokens' in tries[0].body), 'OpenAI : max_completion_tokens');
mock.rejectSpeedParams = false;
await leave();

// 7. Anthropic : route et en-têtes propres
await useProvider('anthropic');
await hover('#p3', 'children');
p = await waitPopup(done);
r = requests.at(-1);
check(r?.path === '/v1/messages' && r.headers['x-api-key'] === 'k-test' && r.headers['anthropic-dangerous-direct-browser-access'] === 'true', 'Anthropic : route messages + en-têtes');
check(r?.body.model === 'claude-haiku-5-5' && r.body.thinking?.type === 'disabled' && p?.title === 'rive', 'Anthropic : Haiku 5.5 sans réflexion, réponse affichée');
await leave();

// 8. OpenRouter : en-têtes d'attribution + modèle gratuit par défaut
await useProvider('openrouter');
await hover('#p3', 'running');
await waitPopup(done);
r = requests.at(-1);
check(r?.headers['x-title'] === 'Hover Translate' && r.body.model.endsWith(':free'), 'OpenRouter : en-têtes + modèle gratuit', r?.body.model);
await leave();

// 9. Identifiants refusés : message clair
await useProvider('groq', 'bad-key');
await hover('#p3', 'happily');
p = await waitPopup(done);
check(p?.dict?.includes('Identifiants refusés par Groq'), 'clé refusée → message clair', p?.dict);
await leave();

// 10. Marge, mode bascule, Échap
await useProvider('gemini');
const margin = await page.evaluate(() => { const b = document.querySelector('#p3').getBoundingClientRect(); return { x: b.right + 60, y: b.top + 10 }; });
await page.mouse.move(margin.x, margin.y);
await page.keyboard.down('Alt');
await page.waitForTimeout(250);
check((await popup()) === null, "aucune pop-up hors d'un mot");
await page.keyboard.up('Alt');
await sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true }); await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }); });
pt = await wordCenter('#p3', 'meadow');
await page.mouse.move(pt.x, pt.y);
p = await waitPopup(done);
check(p?.title === 'rive', 'mode bascule : survol sans touche');
await page.keyboard.press('Escape');
check((await popup()) === null, 'Échap ferme et désactive');

// 11. Page d'options
const extId = sw.url().split('/')[2];
await setSettings({ provider: '', keys: {}, models: {} });
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/src/options.html`);
await opt.waitForTimeout(200);
check(await opt.locator('.provider').count() === 7, 'options : 7 fournisseurs proposés',
  (await opt.locator('.provider b').allTextContents()).join(', '));
check(await opt.locator('#panel').isHidden(), 'options : rien à saisir avant de choisir');
await opt.locator('.provider', { hasText: 'OpenRouter' }).click();
check(await opt.locator('#login').isVisible(), 'options : OpenRouter → bouton « Se connecter »');
await opt.locator('.provider', { hasText: 'Google Gemini' }).click();
check(await opt.locator('#login').isHidden() && (await opt.locator('#key-link').getAttribute('href')).includes('aistudio.google.com'),
  'options : Gemini → champ clé + lien AI Studio');
await opt.fill('#key', 'k-test');
await opt.waitForFunction(() => document.querySelectorAll('#model-list option').length > 0, null, { timeout: 3000 }).catch(() => {});
const models = await opt.locator('#model-list option').evaluateAll((os) => os.map((o) => o.value));
check(models[0] === 'gemini-3.5-flash-lite' && !models.includes('embedding-001') && await opt.inputValue('#model') === 'gemini-3.5-flash-lite',
  'options : liste des modèles chargée, recommandé en tête', JSON.stringify(models));
await opt.click('#save');
await opt.waitForFunction(() => document.querySelector('#status').className === 'ok', null, { timeout: 4000 }).catch(() => {});
const st = await opt.textContent('#status');
check(st.startsWith('✓ Enregistré et fonctionnel') && st.includes('rive'), 'options : enregistrer et tester', st.split('\n')[0]);
check(await opt.locator('.provider input:checked').getAttribute('value') === 'gemini', 'options : fournisseur toujours sélectionné après enregistrement');
await opt.screenshot({ path: path.join(outDir, '2-options.png'), fullPage: true });
const langs = await opt.locator('#targetLang option').allTextContents();
check(langs[0] === 'Automatique — langue du navigateur (français)' && langs.length > 40, 'options : langues', `${langs.length} options`);

// 12. Vrais fournisseurs, clé invalide : l'extension les atteint et affiche un message clair
await sw.evaluate(() => chrome.storage.local.remove('apiBaseOverride'));
await page.bringToFront();
for (const id of ['gemini', 'openrouter', 'openai', 'anthropic', 'groq', 'mistral', 'huggingface']) {
  await setSettings({ provider: id, keys: { [id]: 'invalid-key-123' } });
  await hover('#p3', 'across'); // mot jamais survolé : aucune réponse en cache
  p = await waitPopup((p) => /refusés|HTTP|introuvable|Quota|:/.test(p?.dict ?? ''), 10000);
  check(/Identifiants refusés/.test(p?.dict ?? ''), `réel ${id} : atteint, clé refusée`, p?.dict?.trim());
  await leave();
}

await ctx.close();
server.close();
console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
process.exit(failures ? 1 : 0);
