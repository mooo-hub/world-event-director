const CACHE_NAME = 'world-event-director-api-cache';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const LOCAL_MODELS_KEY = 'world-event-director:models';

export function createApiCacheStore(adapter, { now = () => Date.now() } = {}) {
  return {
    getModels(api = {}) {
      const cache = adapter?.getExtensionSettings?.(CACHE_NAME) ?? {};
      const local = readLocalModels();
      const candidate = cache.models && cache.fingerprint === fingerprint(api) ? cache : local;
      if (!candidate?.models || candidate.fingerprint !== fingerprint(api)) return null;
      return {
        models: candidate.models.map((model) => ({ ...model })),
        stale: now() - Number(candidate.fetchedAt ?? 0) > Number(candidate.ttlMs ?? DEFAULT_TTL_MS),
        fetchedAt: candidate.fetchedAt,
      };
    },
    setModels(models, api = {}) {
      const record = {
        schemaVersion: 1,
        fingerprint: fingerprint(api),
        models: (models ?? []).map((model) => ({ id: model.id, name: model.name, owned_by: model.owned_by })),
        fetchedAt: now(),
        ttlMs: Number(api.modelCacheTtlMs ?? DEFAULT_TTL_MS),
      };
      adapter?.setExtensionSettings?.(CACHE_NAME, record);
      try { globalThis.localStorage?.setItem(LOCAL_MODELS_KEY, JSON.stringify(record)); } catch { /* storage unavailable */ }
      return record;
    },
  };
}

function readLocalModels() {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_MODELS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function fingerprint(api = {}) {
  return `${String(api.baseUrl ?? '').replace(/\/+$/, '')}|${api.connectionMode ?? 'direct'}|${smallHash(api.apiKey ?? '')}`;
}

function smallHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
