const STORAGE_PREFIX = 'world-event-director:generation-checkpoint:';

export function createGenerationCheckpointStore(storage = getSessionStorage()) {
  return {
    read(identity) {
      try {
        const value = storage?.getItem(makeKey(identity));
        if (!value) return null;
        const checkpoint = JSON.parse(value);
        const expectedIdentity = normalizeIdentity(identity);
        if (!sameIdentity(checkpoint?.identity, expectedIdentity)
          || typeof checkpoint.cycleId !== 'string'
          || !Number.isInteger(checkpoint.requestsUsed)
          || checkpoint.requestsUsed < 0
          || checkpoint.requestsUsed > 4) return null;
        return checkpoint;
      } catch {
        return null;
      }
    },
    write(identity, cycleId, requestsUsed) {
      const checkpoint = {
        identity: normalizeIdentity(identity),
        cycleId: String(cycleId ?? ''),
        requestsUsed: Math.min(4, Math.max(0, Math.floor(Number(requestsUsed) || 0))),
      };
      try {
        if (!storage?.setItem) return false;
        storage.setItem(makeKey(identity), JSON.stringify(checkpoint));
        return true;
      } catch {
        return false;
      }
    },
    clear(identity) {
      try {
        storage?.removeItem?.(makeKey(identity));
      } catch { /* session storage can be unavailable in restricted contexts */ }
    },
  };
}

function getSessionStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function makeKey(identity) {
  return `${STORAGE_PREFIX}${encodeURIComponent(JSON.stringify(normalizeIdentity(identity)))}`;
}

function normalizeIdentity(identity = {}) {
  return {
    chatId: String(identity.chatId ?? ''),
    branchId: String(identity.branchId ?? ''),
    characterId: String(identity.characterId ?? ''),
  };
}

function sameIdentity(left = {}, right = {}) {
  return ['chatId', 'branchId', 'characterId'].every((key) => String(left?.[key] ?? '') === right[key]);
}
