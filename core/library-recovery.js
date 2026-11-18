export function resolveCatalogAfterGenerationFailure({ latestStoredLibrary = null, fallbackTemplates = [] } = {}) {
  if (latestStoredLibrary && Array.isArray(latestStoredLibrary.events)) {
    return {
      events: latestStoredLibrary.events,
      source: 'stored',
      shouldPersistFallback: false,
    };
  }
  return {
    events: fallbackTemplates,
    source: 'fallback',
    shouldPersistFallback: true,
  };
}
