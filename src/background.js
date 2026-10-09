import { getSettings, activeProvider, speedParams, resolveTarget, baseLang } from './settings.js';

const LANG_NAMES = new Intl.DisplayNames(['fr'], { type: 'language' });

// ---------- Installation, raccourci, icône, badge ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' && !activeProvider(await getSettings())) chrome.runtime.openOptionsPage();
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-hover') return;
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target?.id) chrome.tabs.sendMessage(target.id, { type: 'toggle' }).catch(() => {});
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'mode' && sender.tab?.id) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.on ? 'ON' : '' });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#2563eb' });
  }
  if (msg.type === 'open-options') chrome.runtime.openOptionsPage();
});

// ---------- Cache (mémoire du service worker) ----------

const CACHE_MAX = 300;
const cache = new Map();

function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------- Traduction : une connexion (port) par mot survolé ----------
// Le content script ferme le port quand la souris passe à un autre mot :
// on annule alors la requête en cours (AbortController).

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate') return;
  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => ctrl.abort());
  port.onMessage.addListener((req) => handle(req, port, ctrl.signal));
});

async function handle(req, port, signal) {
  const send = (m) => {
    if (!signal.aborted) try { port.postMessage(m); } catch {}
  };
  const s = await getSettings();
  const p = activeProvider(s);
  if (!p) return send({ type: 'setup' });

  // Langue source détectée par le content script sur la phrase ('' = inconnue).
  // Identique à la destination : définition dans cette langue au lieu d'une traduction.
  const lang = { target: resolveTarget(s.targetLang), src: req.srcLang || '' };
  lang.mono = !!lang.src && baseLang(lang.src) === baseLang(lang.target);
  const key = [p.id, p.model, lang.target, lang.src, req.text, req.context].join('\u0001');

  const hit = cache.get(key);
  if (hit) return send({ type: 'cached', ...hit });

  const entry = { text: '', label: p.label, mono: lang.mono, timings: {} };
  const t0 = performance.now();
  send({ type: 'start', label: p.label, mono: lang.mono });
  try {
    await streamLlm(p, lang, req, signal, (text) => {
      if (!entry.text) entry.timings.first = Math.round(performance.now() - t0);
      entry.text += text;
      send({ type: 'delta', text });
    });
    entry.timings.total = Math.round(performance.now() - t0);
    if (signal.aborted) return;
    cacheSet(key, entry);
    send({ type: 'done', timings: entry.timings });
  } catch (e) {
    if (!signal.aborted) send({ type: 'error', message: friendlyError(e, p) });
  }
}

function friendlyError(e, p) {
  const status = e.status;
  if (status === 401 || status === 403 || /api key|invalid.*(key|token)/i.test(e.message)) return `Identifiants refusés par ${p.label}. Vérifiez-les dans les réglages.`;
  if (status === 429) return `Quota atteint chez ${p.label}. Réessayez plus tard ou changez de modèle.`;
  if (status === 404) return `Modèle « ${p.model} » introuvable chez ${p.label}.`;
  return `${p.label} : ${e.message}`;
}

// ---------- Consigne ----------

function prompts(lang, req) {
  const target = LANG_NAMES.of(lang.target) ?? lang.target;
  const source = lang.src ? LANG_NAMES.of(baseLang(lang.src)) ?? lang.src : null;
  const common = [
    'On te donne un mot (ou une expression) et la phrase où il apparaît.',
    `Réponds entièrement en ${target}, en texte brut (pas de markdown, pas de préambule), dans ce format exact :`,
  ];
  const system = lang.mono
    ? [
        `Tu es un dictionnaire unilingue instantané (${target}). Tu ne traduis pas : tu définis.`,
        ...common,
        'Ligne 1 : un synonyme ou une définition très courte du mot DANS CE CONTEXTE (1 à 4 mots).',
        'Ligne 2 : catégorie grammaticale · forme de base si le mot est fléchi.',
        'Puis 1 à 3 sens numérotés, celui du contexte en premier :',
        '1. définition courte',
        '   « exemple court »',
        'Sois bref : 8 lignes au maximum.',
      ]
    : [
        `Tu es un dictionnaire bilingue instantané. Tu traduis ${source ? `de : ${source}, ` : ''}vers : ${target}.`,
        ...common,
        'Ligne 1 : la meilleure traduction du mot DANS CE CONTEXTE, seule (1 à 4 mots).',
        "Ligne 2 : catégorie grammaticale · forme de base si le mot est fléchi · langue d'origine.",
        'Puis 1 à 3 sens numérotés, celui du contexte en premier :',
        '1. traduction(s) — définition courte',
        "   « exemple court en langue d'origine » → traduction",
        `Si le mot est déjà en ${target}, ne le traduis pas : donne un synonyme en ligne 1 et ses définitions.`,
        'Sois bref : 8 lignes au maximum.',
      ];
  const user = `Mot : « ${req.text} »\nContexte : « ${req.context || req.text} »`;
  return { system: system.join('\n'), user };
}

// ---------- Appel en streaming ----------

async function streamLlm(p, lang, req, signal, onDelta) {
  const { system, user } = prompts(lang, req);
  let url, headers, body, extract;

  if (p.kind === 'anthropic') {
    url = `${p.base}/messages`;
    headers = {
      'content-type': 'application/json',
      'x-api-key': p.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    body = {
      model: p.model,
      max_tokens: 600,
      stream: true,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low' },
    };
    // Haiku accepte la réflexion désactivée (latence minimale) ; Opus/Sonnet 5.5 la refusent.
    if (p.model.includes('haiku')) body.thinking = { type: 'disabled' };
    extract = (ev) => {
      if (ev.type === 'error') throw new Error(ev.error?.message ?? 'erreur API');
      return ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' ? ev.delta.text : '';
    };
  } else {
    url = `${p.base}/chat/completions`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${p.key}`, ...p.headers };
    body = {
      model: p.model,
      stream: true,
      max_tokens: 600,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...speedParams(p),
    };
    if (p.id === 'openai') {
      // Les modèles récents d'OpenAI n'acceptent que max_completion_tokens.
      delete body.max_tokens;
      body.max_completion_tokens = 1200;
    }
    extract = (ev) => {
      if (ev.error) throw new Error(ev.error.message ?? 'erreur API');
      return ev.choices?.[0]?.delta?.content ?? '';
    };
  }

  let res = await post(url, headers, body, signal);
  // Paramètres de vitesse refusés par ce modèle : on réessaie sans.
  const speed = Object.keys(speedParams(p));
  if (res.status === 400 && speed.length) {
    for (const k of speed) delete body[k];
    res = await post(url, headers, body, signal);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (Array.isArray(j) ? j[0] : j).error?.message ?? '';
    } catch {}
    const err = new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
    err.status = res.status;
    throw err;
  }

  // Lecture SSE : lignes « data: {...} »
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const text = extract(JSON.parse(data));
      if (text) onDelta(text);
    }
  }
}

function post(url, headers, body, signal) {
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
}
