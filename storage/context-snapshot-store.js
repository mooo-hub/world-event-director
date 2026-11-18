export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = 2;
const METADATA_KEY = 'worldEventDirectorContext';

export function createContextSnapshotStore(adapter) {
  return {
    get(identity = {}) {
      const record = adapter?.getChatMetadata?.(METADATA_KEY) ?? null;
      if (!record || record.invalidated || record.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) return null;
      if (!sameIdentity(record.identity, identity)) return null;
      return clone(record);
    },
    replace(snapshot = {}, identity = {}) {
      const record = {
        schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
        identity: pickIdentity(identity),
        context: clone(snapshot.context ?? snapshot),
        contextRevision: snapshot.contextRevision ?? null,
        updatedAt: Date.now(),
      };
      // Dynamic chat is always read from the current host, never restored from a background cache.
      delete record.context.recentMessages;
      delete record.context.sceneContext;
      delete record.context.scene;
      adapter?.setChatMetadata?.(METADATA_KEY, record);
      return clone(record);
    },
    clear(identity = {}) {
      const current = this.get(identity);
      if (!current) return false;
      adapter?.setChatMetadata?.(METADATA_KEY, null);
      return true;
    },
    invalidate(identity = {}) {
      const current = this.get(identity);
      if (current) return adapter?.setChatMetadata?.(METADATA_KEY, { ...current, invalidated: true });
    },
  };
}

function sameIdentity(left = {}, right = {}) {
  return ['chatId', 'branchId', 'characterId'].every((key) => String(left[key] ?? '') === String(right[key] ?? ''));
}

function pickIdentity(identity = {}) {
  return {
    chatId: String(identity.chatId ?? ''),
    branchId: String(identity.branchId ?? 'main'),
    characterId: String(identity.characterId ?? ''),
  };
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
