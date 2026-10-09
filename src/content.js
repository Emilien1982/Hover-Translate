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
        return { text: text.slice(0, 200), rect: r.getBoundingClientRect(), context: contextOf(r.startContainer, r.startOffset) };
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
      if (rect) return { text: seg.segment, rect, context: contextOf(node, seg.index) };
    }
    return null;
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
    const state = { word: hit.text, google: null, llm: '', llmLabel: null, error: null, timings: {}, done: false };
    render(state);
    port.onMessage.addListener((m) => {
      switch (m.type) {
        case 'start': state.llmLabel = m.llmLabel; state.needsKey = m.needsKey; break;
        case 'cached': Object.assign(state, { google: m.google, llm: m.llm, llmLabel: m.llmLabel, needsKey: m.needsKey, timings: { cache: true }, done: true }); break;
        case 'google': state.google = m.google; state.timings.google = m.ms; break;
        case 'delta': state.llm += m.text; break;
        case 'llm-done': state.timings.llm = m.ms; state.timings.first = m.first; break;
        case 'error': state.error = `${m.source} : ${m.message}`; break;
        case 'done': state.done = true; break;
      }
      if (current === hit) render(state);
    });
    port.postMessage({ text: hit.text, context: hit.context });
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
    const lines = st.llm.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    const llmTitleReady = st.llm.includes('\n') || (st.done && lines.length);
    const title = (llmTitleReady && lines[0]) || st.google?.quick || '';
    const body = lines.slice(1);

    card.replaceChildren();
    card.append(title ? el('div', 'title', title) : el('div', 'title skeleton', ' '));

    const meta = el('div', 'word', st.word);
    if (st.google?.src) meta.append(el('span', 'lang', st.google.src.toUpperCase()));
    card.append(meta);

    const dict = el('div', 'dict');
    if (body.length) {
      body.forEach((line, i) => {
        const cls = /^\d+[.)]/.test(line.trim()) ? 'sense' : /^\s|^[«"“]/.test(line) ? 'example' : i === 0 ? 'meta' : 'line';
        dict.append(el('div', cls, line.trim()));
      });
    } else if (st.google?.dict?.length && (!st.llmLabel || st.error || st.done)) {
      for (const d of st.google.dict) {
        const row = el('div', 'line');
        row.append(el('b', '', d.pos + ' '), document.createTextNode(d.terms.join(', ')));
        dict.append(row);
      }
    } else if (st.llmLabel && !st.done) {
      dict.append(el('div', 'skeleton line-sk'), el('div', 'skeleton line-sk short'));
    }
    if (st.error) dict.append(el('div', 'error', st.error));
    if (st.needsKey && st.done && !st.error) {
      dict.append(el('div', 'hint', 'Ajoutez une clé Claude ou OpenAI dans les réglages pour une définition contextuelle.'));
    }
    card.append(dict);

    const t = st.timings;
    const parts = t.cache ? ['cache'] : [
      t.google !== undefined && `Google ${t.google} ms`,
      t.first !== undefined && `${st.llmLabel} ${t.first}→${t.llm ?? '…'} ms`,
    ].filter(Boolean);
    if (parts.length) card.append(el('div', 'footer', parts.join(' · ')));

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
  `;
})();
