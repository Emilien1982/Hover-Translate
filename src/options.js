import { DEFAULTS, LANGUAGES, getSettings, resolveTarget } from './settings.js';

const $ = (id) => document.getElementById(id);
const fields = Object.keys(DEFAULTS);

function showProvider() {
  for (const el of document.querySelectorAll('.provider')) {
    el.classList.toggle('on', el.dataset.p === $('provider').value);
  }
}

function fillLanguages() {
  const ui = navigator.language || 'fr';
  const names = new Intl.DisplayNames([ui], { type: 'language' });
  const sel = $('targetLang');
  const opt = (value, label) => sel.append(new Option(label, value));
  opt('auto', `Automatique — langue du navigateur (${names.of(resolveTarget('auto'))})`);
  LANGUAGES.map((code) => {
    const native = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    const local = names.of(code);
    return [code, local.toLowerCase() === native.toLowerCase() ? local : `${local} — ${native}`];
  })
    .sort((a, b) => a[1].localeCompare(b[1], ui))
    .forEach(([code, label]) => opt(code, label));
}

async function load() {
  fillLanguages();
  const s = await getSettings();
  // Anciennes valeurs hors liste (ex. « fr-CA » saisi à la main) : retour à automatique.
  if (![...$('targetLang').options].some((o) => o.value === s.targetLang)) s.targetLang = 'auto';
  for (const f of fields) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = s[f];
    else el.value = s[f];
  }
  showProvider();
  const [cmd] = (await chrome.commands.getAll()).filter((c) => c.name === 'toggle-hover');
  $('shortcut').textContent = cmd?.shortcut || 'non défini';
}

async function save() {
  const values = {};
  for (const f of fields) {
    const el = $(f);
    values[f] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  values.baseUrl = values.baseUrl.replace(/\/+$/, '');
  await chrome.storage.local.set(values);
  $('saved').textContent = 'Enregistré ✓';
  setTimeout(() => ($('saved').textContent = ''), 1500);
}

function test() {
  const out = $('test-out');
  out.hidden = false;
  out.textContent = '…';
  const t0 = performance.now();
  let quick = '', llm = '', notes = [];
  const port = chrome.runtime.connect({ name: 'translate' });
  port.onMessage.addListener((m) => {
    const ms = Math.round(performance.now() - t0);
    if (m.type === 'google') { quick = m.google.quick; notes.push(`Google : ${m.ms} ms`); }
    if (m.type === 'delta') llm += m.text;
    if (m.type === 'cached') { quick = m.google?.quick ?? ''; llm = m.llm; notes.push('(depuis le cache)'); }
    if (m.type === 'llm-done') notes.push(`IA : 1er mot ${m.first} ms, fin ${m.ms} ms`);
    if (m.type === 'error') notes.push(`ERREUR ${m.source} : ${m.message}`);
    if (m.type === 'done') { notes.push(`Total : ${ms} ms`); port.disconnect(); }
    out.textContent = [quick && `Google → ${quick}`, llm && `\n${llm}`, '', ...notes].filter((x) => x !== false).join('\n');
  });
  port.postMessage({ text: 'bank', context: 'We had a picnic on the bank of the river.' });
}

$('provider').addEventListener('change', showProvider);
$('save').addEventListener('click', save);
$('test').addEventListener('click', async () => { await save(); test(); });
$('edit-shortcut').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
load();
