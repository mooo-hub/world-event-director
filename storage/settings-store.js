export const EXTENSION_NAME = 'world-event-director';
const LOCAL_SETTINGS_KEY = 'world-event-director:settings';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  paused: false,
  eventCheckInterval: 5,
  autoCritical: false,
  templateEventsEnabled: true,
  apiConfiguredAt: null,
  apiReadyFingerprint: null,
  catalog: {
    initialCount: 5,
    refreshEveryTurns: 30,
  },
  allowHighLocationChange: true,
  allowCriticalCancelPlan: false,
  allowCriticalInterruptIntimate: false,
  allowUserAsDirectTarget: false,
  allowRelationshipImpact: true,
  intervals: {
    ambient: 3,
    normal: 5,
    high: 10,
    critical: 15,
  },
  probabilities: {
    ambient: 0.70,
    normal: 0.35,
    high: 0.15,
    critical: 0.05,
  },
  maxProbability: 1,
  criticalCooldownTurns: 30,
  aftermath: {
    minTurns: 2,
    maxTurns: 8,
  },
  api: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    maxTokens: 800,
    connectionMode: 'direct',
    timeoutMs: 8000,
    catalogTimeoutMs: 90000,
  },
  debug: {
    enabled: true,
    maxEntries: 200,
  },
});

export function createSettingsStore(adapter) {
  return {
    get() {
      const stored = adapter?.getExtensionSettings?.(EXTENSION_NAME) ?? {};
      const local = readLocalSettings();
      const settings = mergeSettings(DEFAULT_SETTINGS, mergeSettings(stored, local));
      if (Number(settings.api.catalogTimeoutMs) === 30000) settings.api.catalogTimeoutMs = 90000;
      settings.eventCheckInterval = Math.max(1, Math.min(50, Number(settings.eventCheckInterval) || 5));
      return settings;
    },
  set(patch) {
      const next = mergeSettings(this.get(), patch ?? {});
      adapter?.setExtensionSettings?.(EXTENSION_NAME, next);
      writeLocalSettings(next);
      return next;
    },
    reset() {
      adapter?.setExtensionSettings?.(EXTENSION_NAME, { ...DEFAULT_SETTINGS });
      return this.get();
    },
    maskApiKey() {
      const settings = this.get();
      return {
        ...settings,
        api: {
          ...settings.api,
          apiKey: settings.api.apiKey ? '••••••••' : '',
        },
      };
    },
  };
}

function readLocalSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeLocalSettings(settings) {
  try {
    globalThis.localStorage?.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or storage quotas must not break the extension.
  }
}

export function mergeSettings(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object') {
      result[key] = mergeSettings(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function exportSettings(settings) {
  const safe = mergeSettings(DEFAULT_SETTINGS, settings ?? {});
  return {
    ...safe,
    api: {
      ...safe.api,
      apiKey: '',
    },
  };
}
