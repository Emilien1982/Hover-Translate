// Content script : détecte le mot sous la souris quand le mode est actif
// (touche maintenue ou raccourci bascule) et affiche la pop-up de traduction.
(() => {
  if (window.__hoverTranslate) return;
  window.__hoverTranslate = true;

  let holdKey = 'Alt';
  chrome.storage.local.get('holdKey').then((s) => { if (s.holdKey !== undefined) holdKey = s.holdKey; });
  chrome.storage.onChanged.addListener((c) => { if (c.holdKey) holdKey = c.holdKey.newValue; });

  let toggled = false; // mode bascule (raccourci clavier)
  let held = false; // touche maintenue
  const active = () => toggled || held;

  let mouseX = -1, mouseY = -1;
  let probeTimer = 0;
  let current = null; // { text, rect }
  let port = null;

  const segLocale = document.documentElement.lang || undefined;
  const wordSeg = new Intl.Segmenter(segLocale, { granularity: 'word' });
  const sentenceSeg = new Intl.Segmenter(segLocale, { granularity: 'sentence' });

  // ---------- Détection du mot ----------

  const inside = (r, x, y, pad = 0) =>
    x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;

  function wordAt(x, y) {
    // Une sélection survolée est traduite telle quelle (expressions de plusieurs mots).
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      const text = sel.toString().trim();
      if (text && [...r.getClientRects()].some((rc) => inside(rc, x, y))) {
        return { text: text.slice(0, 200), rect: r.getBoundingClientRect(), context: contextOf(r.startContainer, r.startOffset), declaredLang: declaredLang(r.startContainer) };
      }
    }
    const caret = document.caretRangeFromPoint?.(x, y);
    const node = caret?.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    if (node.parentElement?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return null;

    const segments = wordSeg.segment(node.data);
    for (const off of [caret.startOffset, caret.startOffset - 1]) {
      if (off < 0) continue;
      const seg = segments.containing(off);
      if (!seg?.isWordLike || !/\p{L}/u.test(seg.segment)) continue;
      const range = document.createRange();
      range.setStart(node, seg.index);
      range.setEnd(node, seg.index + seg.segment.length);
      // caretRangeFromPoint renvoie le caret le plus proche, même dans une marge :
      // on vérifie que la souris est réellement sur le mot.
      const rect = [...range.getClientRects()].find((rc) => inside(rc, x, y, 1));
      if (rect) return { text: seg.segment, rect, context: contextOf(node, seg.index), declaredLang: declaredLang(node) };
    }
    return null;
  }

  function declaredLang(node) {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return el?.closest('[lang]')?.getAttribute('lang') || '';
  }

  // Phrase contenant le mot, pour que le LLM choisisse le bon sens.
  function contextOf(node, offset) {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const block = el?.closest('p, li, dd, dt, td, th, h1, h2, h3, h4, h5, h6, blockquote, figcaption, div, section, article') ?? el;
    let full = block?.textContent ?? '';
    let idx;
    if (full.length > 5000 || !block) {
      full = node.textContent ?? '';
      idx = offset;
    } else {
      const pre = document.createRange();
      pre.setStart(block, 0);
      pre.setEnd(node, offset);
      idx = pre.toString().length;
    }
    const sentence = sentenceSeg.segment(full).containing(Math.min(idx, Math.max(full.length - 1, 0)));
    return (sentence?.segment ?? full).replace(/\s+/g, ' ').trim().slice(0, 400);
  }

  // Langue source, détectée sur la phrase (un mot seul est trop ambigu : « pain », « chat »…).
  // 1) détecteur intégré à Chrome, sur l'appareil ; 2) attribut lang le plus proche ; 3) '' = Google devine.
  let detector;
  function getDetector() {
    if (detector === undefined) {
      detector = 'LanguageDetector' in self
        ? LanguageDetector.availability()
            .then((a) => (a === 'available' ? LanguageDetector.create() : null))
            .catch(() => null)
        : Promise.resolve(null);
    }
    return detector;
  }

  async function sourceLang(hit) {
    const d = await getDetector();
    if (d && hit.context.length >= 12) {
      try {
        const [top] = await d.detect(hit.context);
        if (top && top.detectedLanguage !== 'und' && top.confidence >= 0.5) return top.detectedLanguage;
      } catch {}
    }
    return hit.declaredLang || '';
  }

  // ---------- Événements ----------

  function probe() {
    probeTimer = 0;
    if (!active() || mouseX < 0) return;
    if (host && inside(card.getBoundingClientRect(), mouseX, mouseY)) return; // on lit la pop-up
    const hit = wordAt(mouseX, mouseY);
    if (!hit) return;
    if (current && current.text === hit.text && inside(current.rect, mouseX, mouseY, 2)) return;
    lookup(hit);
  }

  addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (active()) {
      clearTimeout(probeTimer);
      probeTimer = setTimeout(probe, 60);
    } else if (current && !nearPopup(mouseX, mouseY)) {
      hide();
    }
  }, { passive: true, capture: true });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (current || toggled)) {
      hide();
      if (toggled) setToggled(false);
      return;
    }
    if (holdKey && e.key === holdKey && !e.repeat) {
      held = true;
      probe();
    }
  }, true);

  addEventListener('keyup', (e) => { if (e.key === holdKey) held = false; }, true);
  addEventListener('blur', () => { held = false; });
  addEventListener('scroll', () => { if (current) hide(); }, { passive: true, capture: true });
  addEventListener('mousedown', (e) => { if (current && !e.composedPath().includes(host)) hide(); }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'toggle' && window === window.top) setToggled(!toggled);
    if (msg.type === 'toggle' && window !== window.top) toggled = !toggled;
  });

  function setToggled(on) {
    toggled = on;
    if (!on) hide();
    chrome.runtime.sendMessage({ type: 'mode', on }).catch(() => {});
    toast(on ? 'Traduction au survol : activée (Échap pour quitter)' : 'Traduction au survol : désactivée');
    if (on) probe();
  }

  function nearPopup(x, y) {
    if (inside(current.rect, x, y, 24)) return true;
    return host ? inside(card.getBoundingClientRect(), x, y, 24) : false;
  }

  // ---------- Requête ----------

  function lookup(hit) {
    current = hit;
    port?.disconnect();
    port = chrome.runtime.connect({ name: 'translate' });
    const state = { word: hit.text, srcLang: '', text: '', label: '', mono: false, setup: false, error: null, timings: {}, done: false };
    render(state);
    port.onMessage.addListener((m) => {
      switch (m.type) {
        case 'setup': state.setup = true; state.done = true; break;
        case 'start': state.label = m.label; state.mono = m.mono; break;
        case 'cached': Object.assign(state, { text: m.text, label: m.label, mono: m.mono, timings: { cache: true }, done: true }); break;
        case 'delta': state.text += m.text; break;
        case 'done': state.timings = m.timings; state.done = true; break;
        case 'error': state.error = m.message; state.done = true; break;
      }
      if (current === hit) render(state);
    });
    const p = port;
    sourceLang(hit).then((srcLang) => {
      state.srcLang = srcLang;
      if (p === port) p.postMessage({ text: hit.text, context: hit.context, srcLang });
    });
  }

  // ---------- Pop-up (Shadow DOM : styles isolés de la page) ----------

  let host = null, root = null, card = null;

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement('hover-translate-popup');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="card" role="tooltip"></div>`;
    card = root.querySelector('.card');
    document.documentElement.appendChild(host);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render(st) {
    ensureHost();
    card.replaceChildren();

    if (st.setup) {
      card.append(el('div', 'title', 'Hover Translate'));
      card.append(el('div', 'dict', "Connectez un fournisseur d'IA (Gemini gratuit, OpenRouter, ChatGPT…) pour traduire au survol."));
      const btn = el('button', 'setup', 'Configurer');
      btn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-options' }));
      card.append(btn);
      return place();
    }

    // Le titre n'apparaît qu'une fois la 1re ligne du LLM complète : jamais de traduction provisoire.
    const lines = st.text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    const titleReady = st.text.includes('\n') || (st.done && lines.length);
    const title = titleReady ? lines[0] : '';
    const body = titleReady ? lines.slice(1) : [];

    card.append(title ? el('div', 'title', title) : el('div', 'title skeleton', '\u00a0'));

    const meta = el('div', 'word', st.mono ? `${st.word} · définition` : st.word);
    if (st.srcLang) meta.append(el('span', 'lang', st.srcLang.split('-')[0].toUpperCase()));
    card.append(meta);

    const dict = el('div', 'dict');
    body.forEach((line, i) => {
      const cls = /^\d+[.)]/.test(line.trim()) ? 'sense' : /^\s|^[«"“]/.test(line) ? 'example' : i === 0 ? 'meta' : 'line';
      dict.append(el('div', cls, line.trim()));
    });
    if (!st.done && body.length < 2) dict.append(el('div', 'skeleton line-sk'), el('div', 'skeleton line-sk short'));
    if (st.error) dict.append(el('div', 'error', st.error));
    card.append(dict);

    const t = st.timings;
    const foot = t.cache ? `${st.label} · cache` : t.first !== undefined ? `${st.label} · ${t.first}→${t.total} ms` : st.label;
    if (foot) card.append(el('div', 'footer', foot));

    place();
  }

  function place() {
    const r = current.rect;
    const w = card.offsetWidth, h = card.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = innerHeight;
    let top = r.bottom + 8;
    if (top + h > vh - 8 && r.top - h - 8 > 8) top = r.top - h - 8;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8));
    host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function hide() {
    port?.disconnect();
    port = null;
    current = null;
    host?.remove();
    host = null;
  }

  function toast(text) {
    if (window !== window.top) return;
    document.querySelector('hover-translate-toast')?.remove();
    const t = document.createElement('hover-translate-toast');
    t.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; bottom: 20px; right: 20px;';
    t.attachShadow({ mode: 'open' }).innerHTML = `<style>${CSS}</style><div class="toast">${text}</div>`;
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  const CSS = `
    :host { color-scheme: light dark; }
    .card, .toast {
      --bg: #ffffff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --accent: #2563eb; --sk: #eef0f3;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line);
      border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.18);
    }
    @media (prefers-color-scheme: dark) {
      .card, .toast { --bg: #1f2937; --fg: #f3f4f6; --muted: #9ca3af; --line: #374151; --accent: #60a5fa; --sk: #2b3646; }
    }
    .card { width: max-content; max-width: 340px; min-width: 180px; padding: 12px 14px 10px; box-sizing: border-box; }
    .title { font-size: 20px; font-weight: 650; line-height: 1.2; color: var(--accent); margin-bottom: 2px; }
    .word { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .lang { margin-left: 6px; padding: 0 4px; border: 1px solid var(--line); border-radius: 4px; font-size: 10px; }
    .dict { border-top: 1px solid var(--line); padding-top: 7px; }
    .meta { color: var(--muted); font-style: italic; margin-bottom: 4px; }
    .sense { margin-top: 4px; }
    .example { color: var(--muted); padding-left: 14px; font-size: 12px; }
    .line { margin: 2px 0; }
    .error { color: #dc2626; font-size: 12px; margin-top: 4px; }
    .hint { color: var(--muted); font-size: 11px; margin-top: 6px; }
    .footer { color: var(--muted); font-size: 10px; text-align: right; margin-top: 8px; opacity: .8; }
    .skeleton { background: var(--sk); border-radius: 4px; animation: pulse 1s ease-in-out infinite; }
    .title.skeleton { width: 120px; }
    .line-sk { height: 10px; margin: 6px 0; width: 260px; max-width: 100%; }
    .line-sk.short { width: 160px; }
    @keyframes pulse { 50% { opacity: .5; } }
    .toast { padding: 8px 12px; font-size: 12px; }
    .setup { margin-top: 10px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  `;
})();
