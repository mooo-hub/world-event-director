// Event-library receipts are authoritative; chat state is a recoverable mirror.
export function createInjectionLifecycle({ libraryStore, stateStore, injector, now = Date.now, isCurrent = () => true }) {
  async function mirror(identity, patch) {
    if (!isCurrent(identity)) return;
    stateStore.patch(patch, identity);
    await stateStore.flush?.();
  }
  function matching(record, token) {
    const catalog = record.catalogs[record.currentCatalogRevision];
    const receipt = record.injectionReceipts[token?.injectionId];
    const latest = Object.entries(record.injectionReceipts).filter(([, item]) => item.eventId === token?.eventId).at(-1)?.[0];
    return catalog && token?.revision === record.currentCatalogRevision
      && receipt?.revision === token.revision && receipt.eventId === token.eventId
      && latest === token.injectionId ? { catalog, receipt } : null;
  }
  return {
    async stage(event, identity) {
      if (!isCurrent(identity)) return null;
      const injection = injector.inject(event);
      const record = await libraryStore.update(identity, (record) => {
        const catalog = record.catalogs[record.currentCatalogRevision];
        if (!catalog?.events.some((item) => item.id === event.id) || catalog.statusByEventId[event.id] !== 'generated') return null;
        catalog.statusByEventId[event.id] = 'pending';
        record.injectionReceipts[injection.injectionId] = {
          revision: catalog.revision, eventId: event.id, phase: 'registered', at: now(),
        };
        return record;
      });
      if (!record) { injector.clear(); return null; }
      const token = { revision: record.currentCatalogRevision, eventId: event.id, injectionId: injection.injectionId };
      await mirror(identity, {
        pendingEvent: event,
        injection: { id: token.injectionId, eventId: event.id, revision: token.revision,
          method: injection.ok ? injection.method : 'manual', status: 'registered' },
        flags: { ...stateStore.get(identity).flags, pendingManualPrompt: injection.ok ? null : injection.prompt },
      });
      return token;
    },
    async include(identity, token) {
      const record = await libraryStore.update(identity, (record) => {
        const match = matching(record, token);
        if (!match || match.receipt.phase !== 'registered' || match.catalog.statusByEventId[token.eventId] !== 'pending') return null;
        match.catalog.statusByEventId[token.eventId] = 'occurred';
        match.catalog.consecutiveUnselectedByEventId[token.eventId] = 0;
        match.receipt.phase = 'included';
        match.receipt.at = now();
        return record;
      });
      if (!record) return false;
      const state = stateStore.get(identity);
      if (state.injection?.id === token.injectionId) {
        await mirror(identity, { injection: { ...state.injection, status: 'included_in_request', includedAt: now() } });
      }
      return true;
    },
    async finish(identity, token, { failed = false, completed = false, reason = 'cancelled' } = {}) {
      const record = await libraryStore.update(identity, (record) => {
        const match = matching(record, token);
        if (!match || !['registered', 'included'].includes(match.receipt.phase)) return null;
        if (failed) {
          match.catalog.statusByEventId[token.eventId] = 'generated';
          match.catalog.injectionFailureByEventId[token.eventId] = { reason, at: now() };
          match.receipt.phase = 'failed';
        } else if (completed && match.receipt.phase === 'included') {
          match.receipt.phase = 'completed';
        } else return null; // An ended hook alone is not proof of success.
        match.receipt.at = now();
        return record;
      });
      if (!record) return false;
      const state = stateStore.get(identity);
      if (state.injection?.id === token.injectionId) {
        const event = state.pendingEvent;
        injector.clear();
        await mirror(identity, {
          pendingEvent: null, injection: null,
          flags: { ...state.flags, pendingManualPrompt: null },
          ...(!failed && event ? { lastInsertedEvent: { id: event.id, title: event.title,
            severity: event.severity, insertedAt: now() } } : {}),
        });
      }
      return true;
    },
    async recover(identity) {
      let record = libraryStore.get(identity);
      if (!record) return;
      let state = stateStore.get(identity);
      const catalog = record.catalogs[record.currentCatalogRevision];
      // A crash between the authoritative write and mirror write must not strand pending.
      const pending = Object.entries(record.injectionReceipts).find(([id, receipt]) =>
        receipt.revision === catalog?.revision && receipt.phase === 'registered'
        && catalog.statusByEventId[receipt.eventId] === 'pending'
        && state.injection?.id === id && state.pendingEvent?.id === receipt.eventId);
      const orphanIds = Object.keys(catalog?.statusByEventId ?? {}).filter((id) =>
        catalog.statusByEventId[id] === 'pending' && pending?.[1].eventId !== id);
      if (orphanIds.length) {
        await libraryStore.update(identity, (next) => {
          for (const id of orphanIds) next.catalogs[next.currentCatalogRevision].statusByEventId[id] = 'generated';
          return next;
        });
      }
      if (!pending && (state.pendingEvent || state.injection)) {
        injector.clear();
        await mirror(identity, { pendingEvent: null, injection: null, flags: { ...state.flags, pendingManualPrompt: null } });
      }
    },
  };
}

export function canAutomaticallyReplace(record) {
  const catalog = record?.catalogs?.[record.currentCatalogRevision];
  if (!catalog || catalog.events.length < 5) return false;
  return catalog.events.every((event) => catalog.statusByEventId[event.id] === 'occurred'
    && Object.values(record.injectionReceipts).some((receipt) => receipt.revision === catalog.revision
      && receipt.eventId === event.id && receipt.phase === 'completed'));
}
