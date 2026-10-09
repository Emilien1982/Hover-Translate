// Réglages partagés entre le service worker et la page d'options.
// Stockés dans chrome.storage.local (jamais synchronisés : la clé API reste sur la machine).

export const DEFAULTS = {
  targetLang: 'auto', // 'auto' = langue de l'interface du navigateur
  holdKey: 'Alt', // touche à maintenir pendant le survol ('' = désactivé)
  googleQuick: true, // titre instantané via Google Translate
  provider: 'anthropic', // 'anthropic' | 'openai' | 'none'
  anthropicKey: '',
  anthropicModel: 'claude-haiku-5-5',
  openaiKey: '',
  openaiModel: 'gpt-5-mini',
  baseUrl: '', // optionnel : proxy ou serveur compatible (sans slash final)
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
}

export function activeLlm(s) {
  if (s.provider === 'anthropic' && s.anthropicKey) {
    return { kind: 'anthropic', key: s.anthropicKey, model: s.anthropicModel, label: 'Claude' };
  }
  if (s.provider === 'openai' && s.openaiKey) {
    return { kind: 'openai', key: s.openaiKey, model: s.openaiModel, label: 'OpenAI' };
  }
  return null;
}

// Langues courantes acceptées par Google Translate (codes Google).
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
