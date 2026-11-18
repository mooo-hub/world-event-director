import { normalizeTemplate, validateTemplate } from '../core/event-validator.js';
import { shortHash } from '../core/hash.js';

export const EVENT_LIBRARY_SCHEMA_VERSION = 3;
const METADATA_KEY = 'worldEventDirectorEvents';
const EVENT_STATUSES = new Set(['generated', 'pending', 'occurred']);

export function createEventLibraryStore(adapter) {
  let saving = Promise.resolve();
  function save(record) {
    saving = Promise.resolve(adapter?.setChatMetadata?.(METADATA_KEY, record));
    saving.catch(() => {});
    return record;
  }
  function load(identity = {}) {
    const raw = adapter?.getChatMetadata?.(METADATA_KEY);
    if (!raw || typeof raw !== 'object' || !matchesIdentity(raw, identity)) return null;
    if (raw.schemaVersion === EVENT_LIBRARY_SCHEMA_VERSION) return normalizeRecord(raw, identity);
    if (Array.isArray(raw.events)) return migrateLegacyRecord(raw, identity);
    return null;
  }

  return {
    flush: () => saving,
    async update(identity, change) {
      const current = load(identity) ?? {
        schemaVersion: 3, identity: normalizeIdentity(identity), currentCatalogRevision: null,
        pendingCatalogRevision: null, generationCycle: null, injectionReceipts: {},
        catalogMutationRevision: 0, catalogs: {},
      };
      const record = change(current);
      if (!record) return null;
      save(record);
      await saving;
      return record;
    },
    get(identity = {}) {
      const record = load(identity);
      if (!record) return null;
      const current = record.catalogs[record.currentCatalogRevision];
      return {
        ...record,
        source: current?.source ?? 'user',
        generatedAt: current?.generatedAt ?? null,
        backgroundRevision: current?.backgroundRevision ?? null,
        updatedAt: current?.updatedAt ?? null,
        events: current ? projectEventStatuses(current) : [],
      };
    },
    replace(events, identity = {}, metadata = {}) {
      const current = load(identity);
      const source = metadata.source ?? 'user';
      const startsBatch = source !== 'user' || !current?.currentCatalogRevision;
      const revision = startsBatch ? createId('rev') : current.currentCatalogRevision;
      const previous = current?.catalogs?.[revision];
      const accepted = validateEvents(events);
      const statusByEventId = Object.fromEntries(accepted.map((event) => {
        const previousStatus = previous?.statusByEventId?.[event.id];
        const status = previousStatus ?? 'generated';
        return [event.id, status];
      }));
      const catalog = {
        revision,
        generationTransactionId: metadata.generationTransactionId ?? previous?.generationTransactionId ?? createId('txn'),
        source,
        createdAt: previous?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        generatedAt: metadata.generatedAt ?? previous?.generatedAt ?? null,
        backgroundRevision: metadata.backgroundRevision ?? previous?.backgroundRevision ?? null,
        targetCount: metadata.targetCount ?? 5,
        lastAutoFillCheckTurn: previous?.lastAutoFillCheckTurn ?? null,
        events: accepted,
        statusByEventId,
        consecutiveUnselectedByEventId: preserveCounts(accepted, previous?.consecutiveUnselectedByEventId),
        injectionFailureByEventId: preserveFailures(accepted, previous?.injectionFailureByEventId),
      };
      const catalogs = { ...(current?.catalogs ?? {}), [revision]: catalog };
      const record = {
        schemaVersion: EVENT_LIBRARY_SCHEMA_VERSION,
        identity: normalizeIdentity(identity, current?.identity),
        currentCatalogRevision: revision,
        // An explicit edit/import invalidates any in-flight generation, including its old budget.
        pendingCatalogRevision: null,
        generationCycle: null,
        injectionReceipts: startsBatch ? {} : Object.fromEntries(Object.entries(current?.injectionReceipts ?? {})
          .filter(([, receipt]) => accepted.some((event) => event.id === receipt.eventId))),
        catalogMutationRevision: (current?.catalogMutationRevision ?? 0) + 1,
        catalogs,
      };
      save(record);
      return { ...record, ...catalog, events: projectEventStatuses(catalog) };
    },
    transitionEvent(eventId, status, identity = {}, receipt = null) {
      if (!EVENT_STATUSES.has(status)) return null;
      const current = load(identity);
      if (!current?.currentCatalogRevision) return null;
      if (receipt?.revision && receipt.revision !== current.currentCatalogRevision) return null;
      const catalog = current.catalogs[current.currentCatalogRevision];
      if (!catalog.events.some((event) => event.id === eventId)) return null;
      const nextCatalog = {
        ...catalog,
        statusByEventId: { ...catalog.statusByEventId, [eventId]: status },
        consecutiveUnselectedByEventId: {
          ...catalog.consecutiveUnselectedByEventId,
          ...(status === 'occurred' ? { [eventId]: 0 } : {}),
        },
        updatedAt: Date.now(),
      };
      const injectionReceipts = { ...current.injectionReceipts };
      if (receipt?.injectionId) {
        injectionReceipts[receipt.injectionId] = {
          revision: current.currentCatalogRevision,
          eventId,
          phase: receipt.phase,
          at: receipt.at ?? Date.now(),
        };
      }
      const record = {
        ...current,
        catalogs: { ...current.catalogs, [current.currentCatalogRevision]: nextCatalog },
        injectionReceipts,
      };
      save(record);
      return record;
    },
    upsert(event, identity = {}) {
      const current = this.get(identity);
      const events = [...(current?.events ?? []), event].filter((item, index, list) => (
        list.findIndex((candidate) => candidate.id === item.id) === index
      ));
      const next = [...events.filter((item) => item.id !== event.id), event];
      return this.replace(next, identity, { source: 'user', generatedAt: current?.generatedAt ?? null });
    },
    remove(id, identity = {}) {
      const current = this.get(identity);
      return this.replace(
        (current?.events ?? []).filter((event) => event.id !== id),
        identity,
        { source: 'user', generatedAt: current?.generatedAt ?? null },
      );
    },
  };
}

function normalizeRecord(raw, identity) {
  const normalizedIdentity = normalizeIdentity(identity, raw.identity);
  const catalogs = {};
  for (const [revision, catalog] of Object.entries(raw.catalogs ?? {})) {
    if (!catalog || typeof catalog !== 'object') continue;
    const events = validateEvents(catalog.events ?? []);
    const eventIds = new Set(events.map((event) => event.id));
    const statusByEventId = {};
    for (const id of eventIds) {
      statusByEventId[id] = EVENT_STATUSES.has(catalog.statusByEventId?.[id])
        ? catalog.statusByEventId[id]
        : 'generated';
    }
    catalogs[revision] = {
      ...catalog,
      revision,
      events,
      statusByEventId,
      consecutiveUnselectedByEventId: preserveCounts(events, catalog.consecutiveUnselectedByEventId),
      injectionFailureByEventId: preserveFailures(events, catalog.injectionFailureByEventId),
    };
  }
  const currentCatalogRevision = catalogs[raw.currentCatalogRevision] ? raw.currentCatalogRevision : null;
  return {
    schemaVersion: EVENT_LIBRARY_SCHEMA_VERSION,
    identity: normalizedIdentity,
    currentCatalogRevision,
    pendingCatalogRevision: catalogs[raw.pendingCatalogRevision] ? raw.pendingCatalogRevision : null,
    generationCycle: raw.generationCycle && typeof raw.generationCycle === 'object' ? raw.generationCycle : null,
    injectionReceipts: raw.injectionReceipts && typeof raw.injectionReceipts === 'object' ? raw.injectionReceipts : {},
    catalogMutationRevision: Math.max(0, Number(raw.catalogMutationRevision) || 0),
    catalogs,
  };
}

function migrateLegacyRecord(raw, identity) {
  const revision = `legacy-${shortHash(JSON.stringify({ identity: normalizeIdentity(identity, raw), events: raw.events }))}`;
  const events = validateEvents(raw.events);
  const statusByEventId = Object.fromEntries(events.map((event) => [event.id, event.occurred === true ? 'occurred' : 'generated']));
  const catalog = {
    revision,
    generationTransactionId: createId('txn'),
    source: raw.source ?? 'user',
    createdAt: raw.generatedAt ?? raw.updatedAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
    generatedAt: raw.generatedAt ?? null,
    backgroundRevision: raw.backgroundRevision ?? null,
    targetCount: 5,
    lastAutoFillCheckTurn: null,
    events,
    statusByEventId,
    consecutiveUnselectedByEventId: Object.fromEntries(events.map((event) => [event.id, 0])),
    injectionFailureByEventId: {},
  };
  return {
    schemaVersion: EVENT_LIBRARY_SCHEMA_VERSION,
    identity: normalizeIdentity(identity, raw),
    currentCatalogRevision: revision,
    pendingCatalogRevision: null,
    generationCycle: null,
    injectionReceipts: {},
    catalogMutationRevision: 0,
    catalogs: { [revision]: catalog },
  };
}

function projectEventStatuses(catalog) {
  return catalog.events.map((event) => ({
    ...event,
    status: catalog.statusByEventId[event.id] ?? 'generated',
    occurred: catalog.statusByEventId[event.id] === 'occurred',
    consecutiveUnselected: catalog.consecutiveUnselectedByEventId[event.id] ?? 0,
  }));
}

function validateEvents(events) {
  return (Array.isArray(events) ? events : []).flatMap((event) => {
    const normalized = normalizeTemplate(event);
    const validation = validateTemplate(normalized);
    return validation.valid ? [{ ...normalized }] : [];
  });
}

function normalizeIdentity(identity = {}, fallback = {}) {
  return {
    chatId: String(identity.chatId ?? fallback.chatId ?? ''),
    branchId: String(identity.branchId ?? fallback.branchId ?? 'main'),
    characterId: String(identity.characterId ?? fallback.characterId ?? ''),
  };
}

function matchesIdentity(raw, identity = {}) {
  const saved = raw.identity && typeof raw.identity === 'object' ? raw.identity : raw;
  return ['chatId', 'branchId', 'characterId'].every((key) => (
    saved[key] === undefined || identity[key] === undefined || String(saved[key]) === String(identity[key])
  ));
}

function preserveCounts(events, values = {}) {
  return Object.fromEntries(events.map((event) => [event.id, Math.max(0, Number(values?.[event.id]) || 0)]));
}

function preserveFailures(events, values = {}) {
  return Object.fromEntries(events.flatMap((event) => (
    values?.[event.id] && typeof values[event.id] === 'object' ? [[event.id, values[event.id]]] : []
  )));
}

function createId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
