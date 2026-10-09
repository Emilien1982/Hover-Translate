import { getSettings, activeLlm, resolveTarget, baseLang } from './settings.js';

const LANG_NAMES = new Intl.DisplayNames(['fr'], { type: 'language' });

// ---------- Raccourci, icône, badge ----------

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
// on annule alors les requêtes en cours (AbortController).

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
  const llm = activeLlm(s);
  // Langue source détectée par le content script sur la phrase ('' = inconnue).
  // Si elle est identique à la destination : définition dans cette langue au lieu d'une traduction.
  const lang = { target: resolveTarget(s.targetLang), src: req.srcLang || '' };
  lang.mono = !!lang.src && baseLang(lang.src) === baseLang(lang.target);
  const key = [lang.target, lang.src, llm?.kind, llm?.model, s.googleQuick, req.text, req.context].join('\u0001');

  const hit = cache.get(key);
  if (hit) return send({ type: 'cached', ...hit });

  const needsKey = s.provider !== 'none' && !llm;
  const entry = { google: null, llm: '', llmLabel: llm?.label ?? null, needsKey, mono: lang.mono, timings: {} };
  const t0 = performance.now();
  let failed = false;
  send({ type: 'start', llmLabel: entry.llmLabel, needsKey, mono: lang.mono });

  const tasks = [];
  if (s.googleQuick || !llm) {
    tasks.push(
      google(req.text, lang, signal)
        .then((g) => {
          entry.google = g;
          entry.timings.google = Math.round(performance.now() - t0);
          send({ type: 'google', google: g, ms: entry.timings.google });
        })
        .catch((e) => {
          failed = true;
          send({ type: 'error', source: 'Google', message: e.message });
        }),
    );
  }
  if (llm) {
    const onDelta = (text) => {
      if (!entry.llm) entry.timings.first = Math.round(performance.now() - t0);
      entry.llm += text;
      send({ type: 'delta', text });
    };
    tasks.push(
      streamLlm(llm, s, lang, req, onDelta, signal)
        .then(() => {
          entry.timings.llm = Math.round(performance.now() - t0);
          send({ type: 'llm-done', ms: entry.timings.llm, first: entry.timings.first });
        })
        .catch((e) => {
          failed = true;
          send({ type: 'error', source: llm.label, message: e.message });
        }),
    );
  }
  await Promise.allSettled(tasks);
  if (signal.aborted) return;
  if (!failed) cacheSet(key, entry);
  send({ type: 'done' });
}

// ---------- Google Translate (endpoint public, sans clé) ----------

async function google(text, lang, signal) {
  const { src, target } = lang;
  // dt=md : définitions dans la langue source, utilisées quand source = destination.
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dt=bd&dt=md&dj=1' +
    `&sl=${encodeURIComponent(baseLang(src) || 'auto')}&tl=${encodeURIComponent(target)}` +
    `&hl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    quick: (data.sentences ?? []).map((x) => x.trans ?? '').join('').trim(),
    src: data.src ?? '',
    dict: (data.dict ?? []).map((d) => ({ pos: d.pos, terms: (d.terms ?? []).slice(0, 6) })),
    defs: (data.definitions ?? []).slice(0, 3).map((d) => ({
      pos: d.pos,
      glosses: (d.entry ?? []).slice(0, 3).map((e) => e.gloss).filter(Boolean),
    })),
  };
}

// ---------- LLM en streaming ----------

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
        'Sois bref : 8 lignes au maximum.',
      ];
  const user = `Mot : « ${req.text} »\nContexte : « ${req.context || req.text} »`;
  return { system: system.join('\n'), user };
}

async function streamLlm(llm, s, lang, req, onDelta, signal) {
  const { system, user } = prompts(lang, req);
  let url, headers, body, extract;

  if (llm.kind === 'anthropic') {
    url = `${s.baseUrl || 'https://api.anthropic.com'}/v1/messages`;
    headers = {
      'content-type': 'application/json',
      'x-api-key': llm.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    body = {
      model: llm.model,
      max_tokens: 600,
      stream: true,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low' },
    };
    // Haiku accepte la réflexion désactivée (latence minimale) ; Opus/Sonnet 5.5 la refusent.
    if (llm.model.includes('haiku')) body.thinking = { type: 'disabled' };
    extract = (ev) => {
      if (ev.type === 'error') throw new Error(ev.error?.message ?? 'erreur API');
      return ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' ? ev.delta.text : '';
    };
  } else {
    url = `${s.baseUrl || 'https://api.openai.com'}/v1/chat/completions`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${llm.key}` };
    body = {
      model: llm.model,
      stream: true,
      max_completion_tokens: 1200,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (/^(gpt-5|o\d)/.test(llm.model)) body.reasoning_effort = 'minimal';
    extract = (ev) => ev.choices?.[0]?.delta?.content ?? '';
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message ?? ''; } catch {}
    throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
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
