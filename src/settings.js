// Réglages et fournisseurs d'IA, partagés entre le service worker et la page d'options.
// Stockés dans chrome.storage.local (jamais synchronisés : les clés restent sur la machine).

export const DEFAULTS = {
  targetLang: 'auto', // 'auto' = langue de l'interface du navigateur
  holdKey: 'Alt', // touche à maintenir pendant le survol ('' = raccourci bascule uniquement)
  provider: '', // identifiant dans PROVIDERS ; '' = pas encore configuré
  keys: {}, // { [provider]: clé }
  models: {}, // { [provider]: modèle choisi }
};

// kind 'openai' : API compatible Chat Completions (la plupart des fournisseurs).
// prefer : motifs pour choisir le modèle recommandé dans la liste renvoyée par le fournisseur.
export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    badge: 'gratuit',
    kind: 'openai',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHelp: 'Clé gratuite, créée en une minute avec un compte Google.',
    defaultModel: 'gemini-3.5-flash-lite',
    prefer: [/gemini-[\d.]+-flash-lite$/, /flash-lite/, /flash$/],
  },
  openrouter: {
    label: 'OpenRouter',
    badge: 'connexion en 1 clic · modèles gratuits',
    kind: 'openai',
    base: 'https://openrouter.ai/api/v1',
    oauth: true,
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyHelp: 'Accès à des centaines de modèles (Claude, GPT, Gemini…), dont des gratuits marqués « :free ».',
    defaultModel: 'google/gemma-4-31b-it:free',
    prefer: [/^google\/gemma-.*:free$/, /:free$/],
    headers: { 'HTTP-Referer': 'https://github.com/Emilien1982/hover-translate', 'X-Title': 'Hover Translate' },
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    base: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHelp: "Clé API OpenAI. Attention : l'abonnement ChatGPT Plus n'inclut pas l'API.",
    defaultModel: 'gpt-5-mini',
    prefer: [/^gpt-[\d.]+-mini$/, /mini$/],
  },
  anthropic: {
    label: 'Anthropic Claude',
    kind: 'anthropic',
    base: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHelp: "Clé API Anthropic. Attention : l'abonnement Claude Pro n'inclut pas l'API.",
    defaultModel: 'claude-haiku-5-5',
    prefer: [/^claude-haiku-\d+-\d+$/, /haiku/],
  },
  groq: {
    label: 'Groq',
    badge: 'offre gratuite · très rapide',
    kind: 'openai',
    base: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    keyHelp: 'Modèles ouverts (Llama, Qwen…) servis très vite.',
    defaultModel: 'llama-3.3-70b-versatile',
    prefer: [/llama-3\.3-70b/, /70b/, /instant/],
  },
  mistral: {
    label: 'Mistral AI',
    badge: 'offre gratuite',
    kind: 'openai',
    base: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyHelp: 'Modèles européens, offre « Experiment » gratuite.',
    defaultModel: 'mistral-small-latest',
    prefer: [/^mistral-small-latest$/, /small/],
  },
  huggingface: {
    label: 'Hugging Face',
    badge: 'crédits mensuels offerts',
    kind: 'openai',
    base: 'https://router.huggingface.co/v1',
    keyUrl: 'https://huggingface.co/settings/tokens/new?tokenType=fineGrained',
    keyHelp: 'Jeton « fine-grained » avec la permission « Make calls to Inference Providers ».',
    defaultModel: 'google/gemma-4-31B-it',
    prefer: [/gemma-4-31B-it/i, /gemma/i],
  },
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
}

// Fournisseur configuré, ou null si l'utilisateur n'a pas encore fourni d'identifiants.
export function activeProvider(s) {
  const def = PROVIDERS[s.provider];
  const key = s.keys?.[s.provider];
  if (!def || !key) return null;
  return {
    id: s.provider,
    ...def,
    key,
    model: s.models?.[s.provider] || def.defaultModel,
    // Réservé aux tests automatisés (serveur local qui imite le fournisseur) ; absent de l'interface.
    base: s.apiBaseOverride || def.base,
  };
}

// Paramètres pour couper la « réflexion » des modèles qui en ont une : la latence prime.
// Si le fournisseur les refuse, le service worker réessaie sans.
export function speedParams(p) {
  if (p.kind !== 'openai') return {};
  if (p.id === 'openai' && /^(gpt-5|o\d)/.test(p.model)) return { reasoning_effort: 'minimal' };
  if (p.id === 'gemini') return { reasoning_effort: 'none' };
  if (p.id === 'openrouter') return { reasoning: { effort: 'minimal', exclude: true } };
  return {};
}

// Langues courantes (codes Google / ISO 639-1).
export const LANGUAGES = [
  'ar', 'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fr', 'he', 'hi', 'hr',
  'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl',
  'sr', 'sv', 'sw', 'th', 'tl', 'tr', 'uk', 'ur', 'vi', 'zh-CN', 'zh-TW',
];

// Langue de destination effective : « auto » suit la langue du navigateur.
export function resolveTarget(targetLang) {
  if (targetLang && targetLang !== 'auto') return targetLang;
  const ui = navigator.language || 'fr';
  if (ui.startsWith('zh')) return /TW|HK|MO|Hant/i.test(ui) ? 'zh-TW' : 'zh-CN';
  const base = ui.split('-')[0];
  return LANGUAGES.includes(base) ? base : 'en';
}

export const baseLang = (code) => (code || '').split('-')[0].toLowerCase();
