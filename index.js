import { createSillyTavernAdapter } from './adapters/st.js';
import { buildEventGenerationContext, createContextCache } from './core/context-cache.js';
import { createEventEngine } from './core/event-engine.js';
import { createLogger } from './core/log.js';
import { createKeyedMutex } from './core/mutex.js';
import { createPromptInjector } from './core/prompt-injector.js';
import { createSyncManager } from './core/context-sync.js';
import { createTemplateLibrary, loadTemplateLibrary } from './core/template-library.js';
import { createChatStateStore } from './storage/chat-state-store.js';
import { createEventLibraryStore } from './storage/event-library-store.js';
import { createContextSnapshotStore } from './storage/context-snapshot-store.js';
import { createApiCacheStore } from './storage/api-cache-store.js';
import { createSettingsStore, exportSettings, mergeSettings } from './storage/settings-store.js';
import { canAutoGenerate, connectionFingerprint } from './core/connection-readiness.js';
import { requestEventCatalog, testDirectorConnection, fetchModelList } from './api/openai-compatible-client.js';
import { createPanel } from './ui/panel.js';
import { validateCatalogReferences, validateTemplate } from './core/event-validator.js';
import { createCatalogCoordinator, catalogIdentityKey } from './core/catalog-coordinator.js';
import { createGenerationCheckpointStore } from './core/generation-checkpoint.js';
import { createInjectionLifecycle, canAutomaticallyReplace } from './core/injection-lifecycle.js';
import { buildEventPrompt } from './core/prompt-injector.js';
import { injectPromptIntoGenerationData, removeEventPromptFromGenerationData } from './core/request-injector.js';


const logger = createLogger();
const adapter = createSillyTavernAdapter({ logger });
const settingsStore = createSettingsStore(adapter);
const stateStore = createChatStateStore(adapter);
const eventLibraryStore = createEventLibraryStore(adapter);
const contextSnapshotStore = createContextSnapshotStore(adapter);
const apiCacheStore = createApiCacheStore(adapter);
const cache = createContextCache();
const syncManager = createSyncManager({ adapter, cache, stateStore, snapshotStore: contextSnapshotStore, logger });
const injector = createPromptInjector(adapter, logger);
const mutex = createKeyedMutex();
const generationCheckpoints = createGenerationCheckpointStore();

let templateLibrary = createTemplateLibrary();
let engine = createEventEngine({ templates: [] });
let fallbackTemplates = [];
let panel = null;
let disposers = [];
let initialized = false;
let activeRequest = null;
let generationAllowsInjection = false;
let testedConnection = null;
const lifecycle = createInjectionLifecycle({ libraryStore: eventLibraryStore, stateStore, injector,
  isCurrent: (identity) => catalogIdentityKey(identity) === catalogIdentityKey(adapter.getIdentity()) });
const coordinator = createCatalogCoordinator({
  libraryStore: eventLibraryStore, checkpointStore: generationCheckpoints, mutex,
  getIdentity: () => adapter.getIdentity(),
  prepareContext: async (identity) => {
    const context = await syncManager.forGeneration(identity);
    const result = buildEventGenerationContext({ context, state: stateStore.get(identity),
      existingEvents: eventLibraryStore.get(identity)?.events ?? [] });
    if (!result.ok) throw new Error('背景不可用，请重新同步上下文');
    return result.value;
  },
  getBackgroundRevision: () => syncManager.isInvalidated() ? null
    : buildEventGenerationContext({ context: cache.get() }).value?.backgroundRevision,
  request: ({ context, count, existingEvents, requestNumber, previousError, onTiming }) => requestEventCatalog({
    settings: settingsStore.get(), contextSummary: context, count, existingEvents, requestNumber, previousError, logger, onTiming,
  }),
  validate: (event, context) => {
    const template = validateTemplate(event);
    const references = validateCatalogReferences(event, context);
    return { valid: template.valid && references.valid };
  },
  onCommit: async (identity) => { await loadLibraryForChat(identity); renderPanel(); },
  onProgress: (identity, progress) => { patchCatalogDiagnostic(identity, progress); renderPanel(); },
  onRound: (identity, round) => logger.info('事件生成轮次结束', { chatId: identity.chatId, ...round,
    durationMs: round.endedAt - round.startedAt }),
});
const inChat = (identity, task) => mutex.run(catalogIdentityKey(identity), async () => {
  if (catalogIdentityKey(identity) !== catalogIdentityKey(adapter.getIdentity())) return;
  return task();
});
function refreshLibrary(identity) {
  templateLibrary.replace(eventLibraryStore.get(identity)?.events ?? []);
  engine = createEventEngine({ templates: templateLibrary.list() });
}
function currentToken(identity) {
  const state = stateStore.get(identity);
  return state.injection?.id ? { revision: state.injection.revision,
    eventId: state.injection.eventId, injectionId: state.injection.id } : null;
}

export async function onActivate() {
  return initializeWorldEventDirector();
}

export async function onEnable() {
  return initializeWorldEventDirector();
}

export async function onDisable() {
  generationAllowsInjection = false;
  coordinator.cancelAll();
  for (const dispose of disposers) dispose?.();
  disposers = [];
  injector.clear();
  logger.info('世界事件导演已停用');
}

export async function onDelete() {
  contextSnapshotStore.clear(adapter.getIdentity());
  await onDisable();
}

export async function initializeWorldEventDirector() {
  if (initialized) return getSnapshot();
  initialized = true;

  const loaded = await loadTemplateLibrary({ logger });
  fallbackTemplates = loaded.templates;
  const identity = adapter.getIdentity();
  const storedLibrary = eventLibraryStore.get(identity);
  templateLibrary = createTemplateLibrary(storedLibrary?.events ?? loaded.templates);
  engine = createEventEngine({ templates: templateLibrary.list(), logger });

  panel = createPanel({ actions, getSnapshot });
  adapter.mountPanel(panel.element);

  disposers.push(adapter.onMessage((_messageId, type, outcome) => {
    if (activeRequest && outcome?.successful && type !== 'first_message'
      && catalogIdentityKey(activeRequest.identity) === catalogIdentityKey(adapter.getIdentity())) activeRequest.replyObserved = true;
    return runTick({ reason: 'message' });
  }));
  disposers.push(adapter.onChatChanged?.(async () => {
    coordinator.cancelAll();
    activeRequest = null;
    generationAllowsInjection = false;
    injector.clear();
    const identity = adapter.getIdentity();
    await inChat(identity, async () => {
      cache.replace({});
      await loadLibraryForChat(identity);
      if (adapter.hasSelectedCharacter()) await syncManager.restoreOrFullSync(identity);
      renderPanel();
    });
    startInitialCatalog(identity);
  }));
  disposers.push(adapter.onGenerationStarted((type, _options, dryRun) => {
    if (dryRun) return;
    generationAllowsInjection = !['quiet', 'impersonate'].includes(type);
    if (!generationAllowsInjection) { injector.clear(); return; }
    return prepareInjectionForGeneration();
  }));
  disposers.push(adapter.onGenerationData?.((data, dryRun) => addEventPromptToRequest(data, dryRun)));
  disposers.push(adapter.onGenerationStopped?.(() => finishGeneration(true)));
  disposers.push(adapter.onSourcesChanged?.(() => syncManager.invalidate(adapter.getIdentity())));
  disposers.push(adapter.onGenerationEnded?.(() => finishGeneration(false)));

  if (!adapter.hasSelectedCharacter?.()) {
    await loadLibraryForChat(identity);
    logger.info('尚未选择角色，等待 API 配置和角色选择后再同步上下文');
    renderPanel();
    return getSnapshot();
  }
  try {
    await syncManager.restoreOrFullSync(identity);
  } catch (error) {
    logger.warn('上下文初始化失败', { error: error.message });
  }
  await loadLibraryForChat(identity);
  startInitialCatalog(identity);
  logger.info('世界事件导演已启动', { templates: templateLibrary.list().length, templateErrors: loaded.errors.length });
  renderPanel();
  return getSnapshot();
}

async function runTick({ reason = 'manual', force = false } = {}) {
  if (!adapter.hasSelectedCharacter()) return { status: 'waiting-character' };
  const identity = adapter.getIdentity();
  const result = await inChat(identity, async () => {
    const settings = settingsStore.get();
    await loadLibraryForChat(identity);
    let { context, state } = force ? await syncManager.fullSync(identity) : await syncManager.deltaSync(identity);
    if ((state.turn ?? 0) - (state.lastFullSyncTurn ?? 0) >= 50) {
      ({ context, state } = await syncManager.refreshIfHashesChanged(identity));
    }
    const due = state.turn - state.lastEventCheckTurn >= settings.eventCheckInterval;
    let automatic = null;
    if (due && settings.enabled && !settings.paused) {
      const record = eventLibraryStore.get(identity);
      if (await canAutoGenerate({ settings, identity, hasSelectedCharacter: true }) && !coordinator.isRunning(identity)) {
        if (record.events.length < 5) automatic = 'auto_fill';
        else if (canAutomaticallyReplace(record)) automatic = 'auto_new';
      }
    }
    if (state.pendingEvent) {
      if (due) { stateStore.patch({ lastEventCheckTurn: state.turn }, identity); await stateStore.flush(); }
      renderPanel();
      return { automatic, status: 'pending' };
    }
    if (due) {
      const decision = engine.evaluate({ context, state, settings });
      await saveDecision(identity, decision, state.turn);
      if (decision.shouldTrigger) await lifecycle.stage(decision.event, identity);
      refreshLibrary(identity);
    }
    renderPanel();
    return { automatic, status: 'checked', reason };
  });
  // Do not keep the chat lock or host message callback waiting on the event-model network.
  if (result?.automatic) void generateEventCatalog(identity, result.automatic).catch((error) => {
    logger.warn('自动更新未完成，已有事件保留', { error: error.message });
  });
  return result;
}

async function saveDecision(identity, decision, turn) {
  if (decision.candidateIds?.length) await eventLibraryStore.update(identity, (record) => {
    const catalog = record.catalogs[record.currentCatalogRevision];
    for (const id of decision.candidateIds) {
      if (!decision.shouldTrigger || id !== decision.selectedId) {
        catalog.consecutiveUnselectedByEventId[id] = (catalog.consecutiveUnselectedByEventId[id] ?? 0) + 1;
      }
    }
    return record;
  });
  stateStore.patch({ lastEventCheckTurn: turn, lastNoTriggerReason: decision.reason ?? '事件等待插入下一次请求' }, identity);
  await stateStore.flush();
}

async function prepareInjectionForGeneration() {
  const identity = adapter.getIdentity();
  if (!adapter.hasSelectedCharacter()) return;
  let automatic = null;
  await inChat(identity, async () => {
    await loadLibraryForChat(identity);
    const state = stateStore.get(identity);
    const settings = settingsStore.get();
    if (!settings.enabled || settings.paused) { injector.clear(); return; }
    const turn = stateStore.get(identity).turn + 1;
    if (turn - state.lastEventCheckTurn >= settings.eventCheckInterval
      && await canAutoGenerate({ settings, identity, hasSelectedCharacter: true }) && !coordinator.isRunning(identity)) {
      const record = eventLibraryStore.get(identity);
      if (record.events.length < 5) automatic = 'auto_fill';
      else if (canAutomaticallyReplace(record)) automatic = 'auto_new';
    }
    if (!state.pendingEvent) {
      const { context } = await syncManager.deltaSync(identity);
      const decision = engine.evaluate({ context, state: { ...stateStore.get(identity), turn }, settings });
      if (turn - state.lastEventCheckTurn >= settings.eventCheckInterval) await saveDecision(identity, decision, turn);
      if (decision.shouldTrigger) await lifecycle.stage(decision.event, identity);
    }
    activeRequest = { identity, token: currentToken(identity), replyObserved: false };
    refreshLibrary(identity);
    renderPanel();
  });
  // This hook advances the check turn before MESSAGE_RECEIVED. Start automatic work here
  // as well, or the later message callback will always see an already-consumed interval.
  if (automatic) void generateEventCatalog(identity, automatic).catch((error) => {
    logger.warn('自动更新未完成，已有事件保留', { error: error.message });
  });
}

async function addEventPromptToRequest(generateData, dryRun = false) {
  if (dryRun) return;
  const identity = adapter.getIdentity();
  return inChat(identity, async () => {
    const state = stateStore.get(identity);
    const token = currentToken(identity);
    const settings = settingsStore.get();
    if (!generationAllowsInjection || !settings.enabled || settings.paused) {
      injector.clear();
      removeEventPromptFromGenerationData(generateData, token?.injectionId);
      return;
    }
    if (!state.pendingEvent || !token) return;
    const result = injectPromptIntoGenerationData(generateData, {
      prompt: buildEventPrompt(state.pendingEvent, { injectionId: token.injectionId }), injectionId: token.injectionId,
    });
    if (!result.ok) {
      await lifecycle.finish(identity, token, { failed: true, reason: 'insertion_failed' });
    } else {
      await lifecycle.include(identity, token);
      if (activeRequest?.token?.injectionId !== token.injectionId) activeRequest = { identity, token, replyObserved: false };
    }
    refreshLibrary(identity);
    renderPanel();
  });
}

function finishGeneration(stopped) {
  generationAllowsInjection = false;
  const request = activeRequest;
  const completed = request?.replyObserved || adapter.getGenerationOutcome() === 'completed';
  activeRequest = null;
  if (!request?.token) { injector.clear(); return; }
  return inChat(request.identity, async () => {
    await lifecycle.finish(request.identity, request.token, { failed: stopped,
      completed: !stopped && completed, reason: 'cancelled' });
    injector.clear();
    await lifecycle.recover(request.identity);
    refreshLibrary(request.identity);
    renderPanel();
  });
}

const actions = {
  async resync({ generateCatalog = false } = {}) {
    if (!adapter.hasSelectedCharacter?.()) return { ok: false, error: '请先选择角色，再同步上下文' };
    const identity = adapter.getIdentity();
    await inChat(identity, () => syncManager.fullSync(identity));
    if (generateCatalog && settingsStore.get().api.apiKey) {
      try {
        await generateEventCatalog(identity);
      } catch (error) {
        logger.warn('事件清单生成失败，已降级到本地事件清单', { error: error.message });
        await loadLibraryForChat(identity);
      }
    } else {
      await loadLibraryForChat(identity);
    }
    renderPanel();
    return { ok: true, message: '上下文已同步' };
  },
  setPaused(paused) {
    settingsStore.set({ paused: Boolean(paused) });
    if (paused) injector.clear();
    renderPanel();
  },
  async saveSettings(patch) {
    const before = settingsStore.get();
    const savingApi = Boolean(patch?.api);
    let readiness = {};
    if (savingApi) {
      const candidate = mergeSettings(before, patch);
      const fingerprint = await connectionFingerprint(candidate.api);
      const result = testedConnection?.fingerprint === fingerprint && testedConnection.result.ok ? testedConnection.result
        : await testDirectorConnection({ settings: candidate }).catch((error) => ({ ok: false, error: error.message }));
      if (!result.ok) return { ok: false, error: result.error ?? '模型连接不可用，请检查后重新保存' };
      testedConnection = { fingerprint, result };
      readiness = { apiConfiguredAt: Date.now(), apiReadyFingerprint: fingerprint,
        apiHealth: { ...result.health, checkedAt: Date.now() } };
      if (before.apiReadyFingerprint !== fingerprint) coordinator.cancelAll();
    }
    settingsStore.set({
      ...patch,
      ...readiness,
    });
    if (!settingsStore.get().enabled || settingsStore.get().paused) injector.clear();
    engine = createEventEngine({ templates: templateLibrary.list(), logger });
    const hasApiKey = Boolean(settingsStore.get().api.apiKey);
    logger.info(hasApiKey ? 'API 配置已保存，等待选择角色后同步上下文' : '设置已保存');
    renderPanel();
    if (savingApi) startInitialCatalog(adapter.getIdentity());
    return { ok: true, message: '设置已保存' };
  },
  async clearChatState() {
    const identity = adapter.getIdentity();
    return inChat(identity, async () => {
      const token = currentToken(identity);
      if (token) await lifecycle.finish(identity, token, { failed: true, reason: 'user_cleared' });
      stateStore.clear(identity);
      await stateStore.flush();
      injector.clear();
      await eventLibraryStore.update(identity, (record) => ({ ...record, generationCycle: null,
        catalogMutationRevision: record.catalogMutationRevision + 1 }));
      generationCheckpoints.clear(identity);
      refreshLibrary(identity);
      renderPanel();
    });
  },
  async clearContextCache() {
    const identity = adapter.getIdentity();
    contextSnapshotStore.clear(identity);
    cache.replace({});
    logger.info('已清除当前聊天的背景上下文缓存', { chatId: identity.chatId, branchId: identity.branchId });
    await syncManager.fullSync(identity);
    renderPanel();
    return { ok: true, message: '背景缓存已清除并从当前角色卡、世界书和聊天重新构建' };
  },
  getPendingPrompt() {
    const state = stateStore.get(adapter.getIdentity());
    return { ok: Boolean(state.flags?.pendingManualPrompt), prompt: state.flags?.pendingManualPrompt ?? '' };
  },
  confirmManualInjection() {
    const identity = adapter.getIdentity();
    const state = stateStore.get(identity);
    if (!state.pendingEvent || state.injection?.method !== 'manual') {
      return { ok: false, error: '当前没有等待手动插入的事件' };
    }
    stateStore.patch({ injection: { ...state.injection, status: 'confirmed_manual' } }, identity);
    renderPanel();
    return { ok: true, message: '已标记：事件将随下一次模型请求插入' };
  },
  async testApi(settingsPatch = {}) {
    try {
      const settings = mergeSettings(settingsStore.get(), settingsPatch);
      const result = await testDirectorConnection({ settings });
      testedConnection = { fingerprint: await connectionFingerprint(settings.api), result };
      if (!result.ok) throw new Error('API 模型调用或 JSON 能力测试失败');
      logger.info('事件导演 API 测试成功');
      renderPanel();
      return { ok: true, health: result.health, message: '网络、模型调用与 JSON 能力测试通过' };
    } catch (error) {
      logger.warn('事件导演 API 测试失败', { error: error.message });
      renderPanel();
      return { ok: false, error: error.message };
    }
  },
  async fetchModels(settingsPatch = {}) {
    try {
      const settings = mergeSettings(settingsStore.get(), settingsPatch);
      const models = await fetchModelList({ settings, cacheStore: apiCacheStore, force: true });
      logger.info('模型列表获取成功', { count: models.length });
      return { ok: true, models, stale: Boolean(models.stale) };
    } catch (error) {
      logger.warn('模型列表获取失败', { error: error.message });
      return { ok: false, error: error.message };
    }
  },
  exportState() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      settings: exportSettings(settingsStore.get()),
      chatState: stateStore.export(adapter.getIdentity()),
      templates: templateLibrary.list().map(({ consecutiveUnselected, ...event }) => event),
    }, null, 2);
  },
  async importState(jsonText) {
    const data = JSON.parse(jsonText);
    const identity = adapter.getIdentity();
    return inChat(identity, async () => {
      if (data.settings) settingsStore.set(data.settings);
      if (data.templates) {
        const validations = data.templates.map(validateTemplate);
        if (validations.some((result) => !result.valid)) return { ok: false, error: '导入包含不合格事件，原事件库保留' };
        eventLibraryStore.replace(data.templates, identity, { source: 'import' });
        await eventLibraryStore.flush();
        generationCheckpoints.clear(identity);
      }
      // Imported runtime identities and receipts are never applied to this chat.
      injector.clear();
      await lifecycle.recover(identity);
      refreshLibrary(identity);
      renderPanel();
      return { ok: true };
    });
  },
  async setTemplateEnabled(id, enabled) {
    return editLibrary((events) => events.map((event) => event.id === id ? { ...event, enabled: Boolean(enabled) } : event));
  },
  async fillCatalog() {
    return actions.regenerateCatalog('manual_fill');
  },
  async regenerateCatalog(trigger = 'manual_regenerate') {
    if (!adapter.hasSelectedCharacter?.()) return { ok: false, error: '请先选择角色，再生成事件清单' };
    const identity = adapter.getIdentity();
    const filling = trigger === 'manual_fill';
    panel.showToast(filling ? '正在补足事件...' : '正在重新生成事件清单...', 0);
    try {
      const events = await generateEventCatalog(identity, trigger);
      panel.showToast(`${filling ? '事件已补足' : '事件库已更新'}，共 ${events.length} 个事件`, 3000);
      renderPanel();
      return { ok: true, count: events.length, replaced: true };
    } catch (error) {
      panel.showToast(`本次未完成，已有合格事件已保留：${error.message}`, 4000);
      logger.warn('事件生成未完成，已有合格事件已保留', { error: error.message });
      return { ok: false, error: error.message };
    }
  },
  async upsertTemplate(jsonText) {
    const event = JSON.parse(jsonText);
    const validation = validateTemplate(event);
    if (!validation.valid) return { ok: false, error: validation.errors.join('；') };
    return editLibrary((events) => [...events.filter((item) => item.id !== event.id), event]);
  },
  async removeTemplate(id) {
    return editLibrary((events) => events.filter((event) => event.id !== id));
  },
};

async function editLibrary(change) {
  const identity = adapter.getIdentity();
  return inChat(identity, async () => {
    const events = eventLibraryStore.get(identity)?.events ?? [];
    const next = change(events);
    const pendingId = stateStore.get(identity).pendingEvent?.id;
    if (pendingId && !next.some((event) => event.id === pendingId)) {
      await lifecycle.finish(identity, currentToken(identity), { failed: true, reason: 'event_deleted' });
    }
    eventLibraryStore.replace(next, identity, { source: 'user' });
    await eventLibraryStore.flush();
    generationCheckpoints.clear(identity);
    await lifecycle.recover(identity);
    refreshLibrary(identity);
    renderPanel();
    return { ok: true };
  });
}

async function generateEventCatalog(identity, trigger = 'manual_regenerate') {
  if (trigger.startsWith('auto') && !await canAutoGenerate({ settings: settingsStore.get(), identity,
    hasSelectedCharacter: adapter.hasSelectedCharacter() })) return [];
  const pending = coordinator.run(identity, trigger);
  renderPanel();
  const result = await pending;
  if (catalogIdentityKey(identity) === catalogIdentityKey(adapter.getIdentity())) {
    patchCatalogDiagnostic(identity, { status: result.ok ? 'success' : 'failed',
      attempts: result.requestsUsed ?? 0, error: result.error });
    refreshLibrary(identity);
    renderPanel();
  }
  if (!result.ok) throw new Error(result.error);
  return result.events;
}

async function startInitialCatalog(identity) {
  if (catalogIdentityKey(identity) !== catalogIdentityKey(adapter.getIdentity())
    || !adapter.hasSelectedCharacter() || identity.chatId === 'unknown-chat') return;
  const settings = settingsStore.get();
  if (!await canAutoGenerate({ settings, identity, hasSelectedCharacter: adapter.hasSelectedCharacter() })) return;
  if (catalogIdentityKey(identity) !== catalogIdentityKey(adapter.getIdentity())) return;
  const record = eventLibraryStore.get(identity);
  if (!settings.enabled || settings.paused || !settings.api.apiKey || !settings.api.baseUrl
    || !settings.api.model || coordinator.isRunning(identity)) return;
  const cycle = record?.generationCycle;
  if (cycle) {
    if (cycle.acceptedAdded >= cycle.targetAdded || cycle.requestsUsed >= 4) return;
    // Reloading while the first request is in progress must resume its existing budget.
  }
  // Only replace untouched bundled templates, never user edits or an in-flight event.
  if (!cycle && record && (record.source !== 'fallback' || record.events.some((event) => event.status !== 'generated'))) return;
  void generateEventCatalog(identity, 'auto_initial').then(() => {
    if (catalogIdentityKey(identity) === catalogIdentityKey(adapter.getIdentity())) panel.showToast('当前聊天的事件已生成', 3000);
  }).catch((error) => {
    logger.warn('首次事件生成未完成，本地事件仍可使用', { error: error.message });
    if (catalogIdentityKey(identity) === catalogIdentityKey(adapter.getIdentity())) panel.showToast(`生成未完成：${error.message}`, 5000);
  });
}

function patchCatalogDiagnostic(identity, diagnostic) {
  const current = stateStore.get(identity);
  const previous = current.flags?.catalogDiagnostic ?? {};
  const next = Object.fromEntries(Object.entries({ ...previous, ...diagnostic }).filter(([, value]) => value !== undefined));
  stateStore.patch({ flags: { ...current.flags, catalogDiagnostic: next } }, identity);
}

async function loadLibraryForChat(identity) {
  if (catalogIdentityKey(identity) !== catalogIdentityKey(adapter.getIdentity())) return;
  if (!eventLibraryStore.get(identity)) {
    if (!adapter.hasSelectedCharacter() || identity.chatId === 'unknown-chat') {
      templateLibrary.replace([]); return;
    }
    eventLibraryStore.replace(fallbackTemplates, identity, { source: 'fallback' });
    await eventLibraryStore.flush();
  }
  if (!activeRequest || catalogIdentityKey(activeRequest.identity) !== catalogIdentityKey(identity)
    || activeRequest.token?.revision !== eventLibraryStore.get(identity)?.currentCatalogRevision) {
    await lifecycle.recover(identity);
  }
  refreshLibrary(identity);
}

function getSnapshot() {
  const identity = adapter.getIdentity();
  const settings = settingsStore.get();
  return {
    identity,
    context: cache.get(),
    state: stateStore.get(identity),
    settings: settingsStore.maskApiKey(),
    models: apiCacheStore.getModels(settings.api)?.models ?? [],
    templates: templateLibrary.list().map(({ consecutiveUnselected, ...event }) => event),
    catalogUpdatedAt: eventLibraryStore.get(identity)?.updatedAt ?? null,
    catalogBusy: coordinator.isRunning(identity),
    logs: logger.list(),
  };
}

function renderPanel() {
  panel?.render(getSnapshot());
}

if (typeof window !== 'undefined') {
  window.worldEventDirector = {
    initialize: initializeWorldEventDirector,
    actions,
    getSnapshot,
  };
  queueMicrotask(() => initializeWorldEventDirector().catch((error) => logger.error('启动失败', { error: error.message })));
}
