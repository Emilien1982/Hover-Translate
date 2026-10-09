// Réglages partagés entre le service worker et la page d'options.
// Stockés dans chrome.storage.local (jamais synchronisés : la clé API reste sur la machine).

export const DEFAULTS = {
  targetLang: (navigator.language || 'fr').slice(0, 2),
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
