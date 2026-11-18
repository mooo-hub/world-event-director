export function reconcilePendingEvent(state = {}, library = []) {
  const pending = state.pendingEvent;
  if (!pending) return state;
  const isLibraryRecord = !Array.isArray(library) && library && typeof library === 'object';
  const currentRevision = isLibraryRecord ? library.currentCatalogRevision : null;
  const catalog = currentRevision ? library.catalogs?.[currentRevision] : null;
  const events = isLibraryRecord ? catalog?.events ?? [] : library;
  const eventExists = (Array.isArray(events) ? events : []).some((event) => event?.id === pending.id);
  const injectionId = state.injection?.id;
  const receipt = injectionId ? library.injectionReceipts?.[injectionId] : null;
  const validLibraryPending = isLibraryRecord
    && eventExists
    && catalog.statusByEventId?.[pending.id] === 'pending'
    && state.injection?.eventId === pending.id
    && receipt?.eventId === pending.id
    && receipt?.revision === currentRevision
    && receipt?.phase !== 'included';
  if (isLibraryRecord ? validLibraryPending : eventExists) return state;
  return {
    ...state,
    pendingEvent: null,
    injection: null,
    flags: { ...(state.flags ?? {}), pendingManualPrompt: null },
    lastNoTriggerReason: '待插入事件已随事件库更新取消',
  };
}
