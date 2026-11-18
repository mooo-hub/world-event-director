import { stableHash } from './hash.js';
import { buildBackgroundContext, normalizeContext, updateSceneContext } from './context-cache.js';

export function createSyncManager({ adapter, cache, stateStore, snapshotStore = null, logger = console }) {
  let invalidated = false;
  const sameIdentity = (identity) => ['chatId', 'branchId', 'characterId'].every(
    (key) => String(identity?.[key] ?? '') === String(adapter.getIdentity()?.[key] ?? ''));
  function assertIdentity(identity) {
    if (!sameIdentity(identity)) throw new Error('chat_changed_during_sync');
  }
  async function fullSync(identity = adapter.getIdentity(), sources = null) {
    invalidated = true;
    const [character, worldbooks, readMessages, userPersona, preset] = await Promise.all([
      sources?.character ?? adapter.readCharacter(),
      sources?.worldbooks ?? adapter.readWorldbooks(),
      adapter.readRecentMessages(30),
      adapter.readUserPersona?.() ?? null,
      adapter.readPreset?.() ?? null,
    ]);
    const recentMessages = readMessages.slice(-30);
    const previousState = stateStore.get(identity);
    const turn = Number(previousState.turn ?? 0) + countNewReplies(recentMessages, previousState.lastProcessedMessageId);
    const worldbookHash = await stableHash(worldbooks.map((book) => ({ id: book.id, hash: book.hash })));
    const backgroundContext = await buildBackgroundContext({ character, worldbooks });
    if (backgroundContext) {
      backgroundContext.revision.userHash = userPersona?.hash ?? '';
      backgroundContext.revision.presetHash = preset?.hash ?? '';
    }
    assertIdentity(identity);
    const sceneContext = updateSceneContext(stateStore.get(identity).sceneState, recentMessages, backgroundContext);
    const context = cache.replace(normalizeContext({
      identity,
      character,
      worldbooks,
      backgroundContext,
      sceneContext,
      userPersona,
      preset,
      recentMessages,
      worldbookHash,
      syncedAt: Date.now(),
    }));
    const lastMessage = recentMessages.at(-1);
    const state = stateStore.patch({
      chatId: identity.chatId,
      branchId: identity.branchId,
      characterId: identity.characterId,
      characterHash: character.hash,
      worldbookHash,
      sceneState: sceneContext,
      lastProcessedMessageId: lastMessage?.id ?? null,
      lastFullSyncTurn: turn,
      turn,
    }, identity);
    snapshotStore?.replace?.({ context, contextRevision: `${character.hash}:${worldbookHash}:${userPersona?.hash ?? ''}:${preset?.hash ?? ''}:${lastMessage?.id ?? ''}` }, identity);
    invalidated = false;
    logger.info?.('完成上下文完整同步', { chatId: identity.chatId, character: character.name, worldbooks: worldbooks.length });
    return { context, state };
  }

  async function deltaSync(identity = adapter.getIdentity()) {
    const state = stateStore.get(identity);
    const cached = cache.get();
    if (invalidated || !cached.backgroundContext || (cached.identity && JSON.stringify(cached.identity) !== JSON.stringify(identity))) {
      return restoreOrFullSync(identity);
    }
    if (shouldFullSync(state, identity)) return fullSync(identity);

    const messages = await adapter.readMessagesAfter(state.lastProcessedMessageId, 30);
    assertIdentity(identity);
    if (messages.length === 0) return { context: cache.get(), state };
    const context = cache.mergeDelta({ messages });
    const nextState = stateStore.patch({
      sceneState: context.sceneContext,
      lastProcessedMessageId: messages.at(-1)?.id ?? state.lastProcessedMessageId,
      turn: Number(state.turn ?? 0) + countNewReplies(messages),
    }, identity);

    logger.info?.('完成增量同步', { newMessages: messages.length, turn: nextState.turn });
    return { context, state: nextState, delta: { messages } };
  }

  async function refreshIfHashesChanged(identity = adapter.getIdentity()) {
    const state = stateStore.get(identity);
    try {
      const [character, worldbooks] = await Promise.all([adapter.readCharacter(), adapter.readWorldbooks()]);
      assertIdentity(identity);
      const worldbookHash = await stableHash(worldbooks.map((book) => ({ id: book.id, hash: book.hash })));
      if (state.characterHash !== character.hash || state.worldbookHash !== worldbookHash) {
        return fullSync(identity, { character, worldbooks });
      }
      const nextState = stateStore.patch({ lastFullSyncTurn: state.turn }, identity);
      return { context: cache.get(), state: nextState };
    } catch (error) { invalidated = true; throw error; }
  }

  async function restoreOrFullSync(identity = adapter.getIdentity()) {
    const snapshot = snapshotStore?.get?.(identity);
    if (invalidated || !snapshot?.context?.backgroundContext) return fullSync(identity);
    const context = cache.replace({ ...snapshot.context, identity, recentMessages: [], sceneContext: stateStore.get(identity).sceneState, cacheStatus: 'restored' });
    const state = stateStore.get(identity);
    const messages = await adapter.readMessagesAfter?.(state.lastProcessedMessageId, 30) ?? [];
    assertIdentity(identity);
    if (messages.length === 0) return { context, state, restored: true };
    const merged = cache.mergeDelta({ messages });
    const nextState = stateStore.patch({
      sceneState: merged.sceneContext,
      lastProcessedMessageId: messages.at(-1)?.id ?? state.lastProcessedMessageId,
      turn: Number(state.turn ?? 0) + countNewReplies(messages),
    }, identity);

    return { context: merged, state: nextState, restored: true, delta: { messages } };
  }

  async function forGeneration(identity = adapter.getIdentity()) {
    let state = stateStore.get(identity);
    const cached = cache.get();
    if (invalidated || !cached.backgroundContext || !cached.identity
      || JSON.stringify(cached.identity) !== JSON.stringify(identity)) await restoreOrFullSync(identity);
    state = stateStore.get(identity);
    if ((state.turn ?? 0) - (state.lastFullSyncTurn ?? 0) >= 50) await refreshIfHashesChanged(identity);
    const recentMessages = (await adapter.readRecentMessages(30)).slice(-30);
    assertIdentity(identity);
    const context = cache.get();
    if (invalidated || !context.backgroundContext) throw new Error('background_unavailable');
    return cache.replace({ ...context, recentMessages,
      sceneContext: updateSceneContext(context.sceneContext, recentMessages, context.backgroundContext) });
  }
  return { fullSync, deltaSync, refreshIfHashesChanged, restoreOrFullSync, forGeneration,
    isInvalidated: () => invalidated,
    invalidate(identity = adapter.getIdentity()) { invalidated = true; return snapshotStore?.invalidate?.(identity); } };
}

function countNewReplies(messages = [], cursor = null) {
  const index = cursor ? messages.findIndex((message) => message.id === cursor) : -1;
  return messages.slice(index + 1).filter((message) => message.role === 'assistant').length;
}

function shouldFullSync(state, identity) {
  return !state.lastProcessedMessageId || state.chatId !== identity.chatId || state.branchId !== identity.branchId || state.characterId !== identity.characterId;
}
