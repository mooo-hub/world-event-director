export const STATE_SCHEMA_VERSION = 3;

export function createInitialChatState({ chatId = 'unknown-chat', branchId = 'main', characterId = 'unknown-character' } = {}) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    chatId,
    branchId,
    characterId,
    characterHash: '',
    worldbookHash: '',
    lastProcessedMessageId: null,
    turn: 0,
    lastFullSyncTurn: 0,
    lastEventCheckTurn: 0,
    pendingEvent: null,
    injection: null,
    lastInsertedEvent: null,
    lastCheckedTurns: {},
    flags: {},
    sceneState: {},
    lastNoTriggerReason: '尚未开始调度',
    consecutiveApiFailures: 0,
  };
}

export function createChatStateStore(adapter) {
  let saving = Promise.resolve();
  return {
    flush: () => saving,
    get(identity = {}) {
      const current = createInitialChatState(identity);
      const raw = adapter?.getChatMetadata?.('worldEventDirector') ?? null;
      if (raw && !matchesIdentity(raw, identity)) return current;
      return migrateState({ ...current, ...(raw ?? {}) }, identity);
    },
    replace(nextState) {
      const migrated = migrateState(nextState);
      saving = Promise.resolve(adapter?.setChatMetadata?.('worldEventDirector', migrated));
      saving.catch(() => {});
      return migrated;
    },
    patch(patch, identity = {}) {
      return this.replace({ ...this.get(identity), ...(patch ?? {}) });
    },
    clear(identity = {}) {
      return this.replace(createInitialChatState(identity));
    },
    export(identity = {}) {
      const state = this.get(identity);
      return stripSensitiveState(state);
    },
    import(nextState, identity = {}) {
      const migrated = migrateState(nextState, identity);
      return this.replace(migrated);
    },
  };
}

function matchesIdentity(raw, identity = {}) {
  return ['chatId', 'branchId', 'characterId'].every((key) => (
    raw[key] === undefined || identity[key] === undefined || String(raw[key]) === String(identity[key])
  ));
}

export function migrateState(state = {}, identity = {}) {
  const base = createInitialChatState(identity);
  const next = { ...base, ...state };
  next.schemaVersion = STATE_SCHEMA_VERSION;
  next.chatId = identity.chatId ?? next.chatId ?? base.chatId;
  next.branchId = identity.branchId ?? next.branchId ?? base.branchId;
  next.characterId = identity.characterId ?? next.characterId ?? base.characterId;
  if (!next.pendingEvent && next.activeEvent?.phase === 'pending_injection') next.pendingEvent = next.activeEvent;
  if (!next.lastInsertedEvent && next.activeEvent && next.activeEvent.phase !== 'pending_injection') {
    next.lastInsertedEvent = { id: next.activeEvent.id, title: next.activeEvent.title, severity: next.activeEvent.severity, insertedAt: next.activeEvent.triggeredTurn ?? null };
  }
  next.pendingEvent = next.pendingEvent && typeof next.pendingEvent === 'object' ? next.pendingEvent : null;
  next.lastInsertedEvent = next.lastInsertedEvent && typeof next.lastInsertedEvent === 'object' ? next.lastInsertedEvent : null;
  next.lastCheckedTurns = next.lastCheckedTurns && typeof next.lastCheckedTurns === 'object' ? next.lastCheckedTurns : {};
  next.flags = next.flags && typeof next.flags === 'object' ? next.flags : {};
  next.sceneState = next.sceneState && typeof next.sceneState === 'object' ? next.sceneState : {};
  next.injection = next.injection && typeof next.injection === 'object' ? next.injection : null;
  next.turn = Number.isFinite(Number(next.turn)) ? Number(next.turn) : 0;
  next.lastFullSyncTurn = Number.isFinite(Number(next.lastFullSyncTurn)) ? Number(next.lastFullSyncTurn) : 0;
  next.lastEventCheckTurn = Number.isFinite(Number(next.lastEventCheckTurn)) ? Number(next.lastEventCheckTurn) : 0;
  delete next.activeEvent;
  delete next.eventHistory;
  delete next.cooldowns;
  delete next.lastEventCatalogRefreshTurn;
  return next;
}

export function stripSensitiveState(state = {}) {
  const safe = JSON.parse(JSON.stringify(state));
  delete safe.apiKey;
  delete safe.prompt;
  delete safe.rawPrompt;
  if (safe.activeEvent) {
    delete safe.activeEvent.rawPrompt;
    delete safe.activeEvent.apiRequest;
  }
  return safe;
}
