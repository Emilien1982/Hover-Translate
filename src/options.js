import { LANGUAGES, PROVIDERS, getSettings, resolveTarget } from './settings.js';

const $ = (id) => document.getElementById(id);
let settings;

// ---------- Fournisseurs ----------

function renderProviders() {
  const box = $('providers');
  box.replaceChildren();
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const label = document.createElement('label');
    label.className = 'provider';
    label.innerHTML = `<input type="radio" name="provider" value="${id}"><b></b><span class="ok"></span><span class="badge"></span>`;
    label.querySelector('b').textContent = p.label;
    label.querySelector('.badge').textContent = p.badge ?? ' ';
    if (settings.keys[id]) label.querySelector('.ok').textContent = '✓';
    const radio = label.querySelector('input');
    radio.checked = settings.provider === id;
    radio.addEventListener('change', () => selectProvider(id));
    box.append(label);
  }
}

function current() {
  return document.querySelector('input[name=provider]:checked')?.value ?? '';
}

function selectProvider(id) {
  stashFields();
  const p = PROVIDERS[id];
  $('panel').hidden = !p;
  if (!p) return;
  document.querySelectorAll('.pname').forEach((e) => (e.textContent = p.label));
  $('oauth').hidden = !p.oauth;
  $('login-state').textContent = p.oauth && settings.keys[id] ? 'Connecté ✓' : '';
  $('key').value = settings.keys[id] ?? '';
  $('key-help').textContent = p.keyHelp;
  $('key-link').href = p.keyUrl;
  $('model').value = settings.models[id] || p.defaultModel;
  $('model').placeholder = p.defaultModel;
  $('model-list').replaceChildren();
  $('panel').dataset.provider = id;
  if (settings.keys[id]) loadModels(id);
}

// Mémorise la saisie du fournisseur affiché avant d'en changer (rien n'est perdu en naviguant).
function stashFields() {
  const id = $('panel').dataset.provider;
  if (!id) return;
  settings.keys[id] = $('key').value.trim();
  settings.models[id] = $('model').value.trim();
}

// Liste des modèles proposée par le fournisseur, avec le modèle recommandé en tête.
async function loadModels(id) {
  const p = PROVIDERS[id];
  const key = $('key').value.trim();
  if (!key) return;
  const headers = p.kind === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : { authorization: `Bearer ${key}` };
  try {
    const res = await fetch(`${settings.apiBaseOverride || p.base}/models?limit=1000`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    let ids = (json.data ?? json.models ?? []).map((m) => (m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
    if (id === 'gemini') ids = ids.filter((m) => m.startsWith('gemini'));
    if ($('panel').dataset.provider !== id) return;
    const recommended = p.prefer.map((re) => ids.find((m) => re.test(m))).find(Boolean) ?? p.defaultModel;
    $('model-list').replaceChildren(...[recommended, ...ids.filter((m) => m !== recommended)].map((m) => new Option(m === recommended ? 'recommandé' : '', m)));
    if (!settings.models[id] || !ids.includes($('model').value)) $('model').value = recommended;
    $('model-help').textContent = `${ids.length} modèles disponibles. Recommandé : ${recommended}.`;
  } catch (e) {
    $('model-help').textContent = `Liste des modèles indisponible (${e.message}) : vérifiez la clé.`;
  }
}

// ---------- Connexion OpenRouter (OAuth PKCE) ----------

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function openrouterLogin() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(digest));
  const callback = chrome.identity.getRedirectURL('openrouter');
  const url = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;
  $('login-state').textContent = 'Connexion en cours…';
  try {
    const back = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    const code = new URL(back).searchParams.get('code');
    if (!code) throw new Error('aucun code reçu');
    const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { key } = await res.json();
    $('key').value = key;
    $('login-state').textContent = 'Connecté ✓';
    await save();
  } catch (e) {
    $('login-state').textContent = `Échec de la connexion : ${e.message}`;
  }
}

// ---------- Langues ----------

function fillLanguages() {
  const ui = navigator.language || 'fr';
  const names = new Intl.DisplayNames([ui], { type: 'language' });
  const sel = $('targetLang');
  sel.append(new Option(`Automatique — langue du navigateur (${names.of(resolveTarget('auto'))})`, 'auto'));
  LANGUAGES.map((code) => {
    const native = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    const local = names.of(code);
    return [code, local.toLowerCase() === native.toLowerCase() ? local : `${local} — ${native}`];
  })
    .sort((a, b) => a[1].localeCompare(b[1], ui))
    .forEach(([code, label]) => sel.append(new Option(label, code)));
}

// ---------- Enregistrement et test ----------

async function save() {
  stashFields();
  const provider = current();
  settings.provider = provider;
  await chrome.storage.local.set({
    provider,
    keys: settings.keys,
    models: settings.models,
    targetLang: $('targetLang').value,
    holdKey: $('holdKey').value,
  });
  renderProviders();
  if (!provider || !settings.keys[provider]) {
    return status('err', provider ? 'Saisissez une clé (ou connectez-vous) pour ce fournisseur.' : 'Choisissez un fournisseur d\'IA.');
  }
  test();
}

function status(kind, text) {
  const box = $('status');
  box.hidden = false;
  box.className = kind;
  box.textContent = text;
}

function test() {
  status('', 'Test en cours avec « bank » (« the bank of the river »)…');
  let text = '';
  const port = chrome.runtime.connect({ name: 'translate' });
  port.onMessage.addListener((m) => {
    if (m.type === 'delta') text += m.text;
    if (m.type === 'cached') text = m.text;
    if (m.type === 'error') { status('err', `✗ ${m.message}`); port.disconnect(); }
    if (m.type === 'done' || m.type === 'cached') {
      const t = m.timings ? `1er mot en ${m.timings.first} ms, réponse complète en ${m.timings.total} ms` : 'depuis le cache';
      status('ok', `✓ Enregistré et fonctionnel (${t}).\n\n${text.trim()}\n\nRechargez vos onglets ouverts, puis maintenez la touche et survolez un mot.`);
      port.disconnect();
    }
  });
  port.postMessage({ text: 'bank', context: 'We had a picnic on the bank of the river.', srcLang: 'en' });
}

// ---------- Initialisation ----------

async function init() {
  settings = await getSettings();
  settings.keys = { ...settings.keys };
  settings.models = { ...settings.models };
  fillLanguages();
  if (![...$('targetLang').options].some((o) => o.value === settings.targetLang)) settings.targetLang = 'auto';
  $('targetLang').value = settings.targetLang;
  $('holdKey').value = settings.holdKey;
  renderProviders();
  if (settings.provider) selectProvider(settings.provider);

  let debounce;
  $('key').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => loadModels(current()), 500);
  });
  $('login').addEventListener('click', openrouterLogin);
  $('save').addEventListener('click', save);
  $('edit-shortcut').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  const [cmd] = (await chrome.commands.getAll()).filter((c) => c.name === 'toggle-hover');
  $('shortcut').textContent = cmd?.shortcut || 'non défini';
}

init();
