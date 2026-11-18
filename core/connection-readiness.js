import { stableHash } from './hash.js';

export function connectionFingerprint(api = {}) {
  return stableHash([api.baseUrl, api.apiKey, api.model, api.connectionMode ?? 'direct']);
}

export async function canAutoGenerate({ settings, identity, hasSelectedCharacter }) {
  if (!hasSelectedCharacter || !identity?.chatId || identity.chatId === 'unknown-chat'
    || !settings.enabled || settings.paused || !settings.apiConfiguredAt
    || !settings.api?.baseUrl || !settings.api.apiKey || !settings.api.model
    || !settings.apiReadyFingerprint) return false;
  return settings.apiReadyFingerprint === await connectionFingerprint(settings.api);
}
