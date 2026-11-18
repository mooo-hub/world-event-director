import { canAutomaticallyReplace } from './injection-lifecycle.js';

const TARGET = 5;
const MAX_REQUESTS = 4;
const id = (prefix) => `${prefix}-${globalThis.crypto.randomUUID()}`;
export const catalogIdentityKey = (identity = {}) => JSON.stringify([
  String(identity.chatId ?? ''), String(identity.branchId ?? 'main'), String(identity.characterId ?? ''),
]);

export function createCatalogCoordinator({ libraryStore, checkpointStore, mutex, getIdentity,
  prepareContext, getBackgroundRevision, request, validate, onCommit = async () => {}, onProgress = () => {} }) {
  const running = new Map();
  let epoch = 0;
  const current = (identity) => catalogIdentityKey(identity) === catalogIdentityKey(getIdentity());
  const locked = (identity, task) => mutex.run(catalogIdentityKey(identity), task);
  async function execute(identity, trigger) {
    const startedEpoch = epoch;
    const isCurrent = () => epoch === startedEpoch && current(identity);
    let cycle;
    let lastError = null;
    const startedAt = Date.now();
    const rounds = [];
    let timing = null;
    const progress = (extra = {}) => onProgress(identity, { status: 'running', startedAt,
      attempts: cycle?.requestsUsed ?? 0, rounds: rounds.map((round) => ({ ...round })),
      timing, ...extra });
    try {
      cycle = await locked(identity, async () => {
        if (!isCurrent()) throw new Error('聊天已经切换，本次操作已取消');
        const previous = libraryStore.get(identity);
        const fill = trigger.endsWith('fill');
        const retained = fill ? previous?.events.length ?? 0 : 0;
        if (fill && retained >= TARGET) return null;
        if (trigger === 'auto_new' && previous?.events.length && !canAutomaticallyReplace(previous)) return null;
        const checkpoint = checkpointStore.read(identity);
        const old = previous?.generationCycle;
        if (trigger.startsWith('auto') && checkpoint && (!old || checkpoint.cycleId !== old.cycleId)) {
          throw new Error('生成请求记录未恢复一致，请手动点击补足事件或重新生成');
        }
        const resume = trigger.startsWith('auto') && old && old.requestsUsed < MAX_REQUESTS
          && old.acceptedAdded < old.targetAdded;
        if (resume) {
          const catalog = previous.catalogs[old.revision];
          if (!catalog || catalog.events.length !== old.retainedCount + old.acceptedAdded) {
            throw new Error('生成记录与事件数量不一致，请点击重新生成或补足事件');
          }
          return { ...old, requestsUsed: Math.max(old.requestsUsed,
            checkpoint?.cycleId === old.cycleId ? checkpoint.requestsUsed : 0) };
        }
        const next = {
          cycleId: id('cycle'), trigger, revision: fill && previous?.currentCatalogRevision
            ? previous.currentCatalogRevision : id('rev'),
          retainedCount: retained, targetAdded: TARGET - retained, acceptedAdded: 0, requestsUsed: 0,
        };
        await libraryStore.update(identity, (record) => {
          // Discard only empty, never-visible candidates from an earlier unsuccessful cycle.
          if (record.pendingCatalogRevision && record.pendingCatalogRevision !== record.currentCatalogRevision) {
            delete record.catalogs[record.pendingCatalogRevision];
          }
          if (!record.catalogs[next.revision]) record.catalogs[next.revision] = {
            revision: next.revision, generationTransactionId: id('txn'), source: 'api',
            createdAt: Date.now(), updatedAt: Date.now(), targetCount: TARGET,
            events: [], statusByEventId: {}, consecutiveUnselectedByEventId: {}, injectionFailureByEventId: {},
          };
          record.generationCycle = next;
          record.pendingCatalogRevision = record.currentCatalogRevision === next.revision ? null : next.revision;
          return record;
        });
        return next;
      });
      if (!cycle) return { ok: true, skipped: true, events: libraryStore.get(identity)?.events ?? [] };
      progress({ error: null });
      while (cycle.requestsUsed < MAX_REQUESTS && cycle.acceptedAdded < cycle.targetAdded) {
        const prepared = await locked(identity, async () => {
          if (!isCurrent()) throw new Error('聊天已经切换，本次操作已取消');
          const context = await prepareContext(identity);
          if (!isCurrent()) throw new Error('聊天已经切换，本次操作已取消');
          const before = libraryStore.get(identity);
          if (before?.generationCycle?.cycleId !== cycle.cycleId) throw new Error('事件库已更新，本次旧请求已取消');
          const requestToken = id('request');
          const nextCycle = { ...cycle, requestsUsed: cycle.requestsUsed + 1, requestToken };
          if (!checkpointStore.write(identity, cycle.cycleId, nextCycle.requestsUsed)) {
            throw new Error('无法保存本次请求次数，未发送模型请求');
          }
          await libraryStore.update(identity, (record) => ({ ...record, generationCycle: nextCycle }));
          cycle = nextCycle;
          return { context, revision: context.backgroundRevision,
            mutation: before.catalogMutationRevision, requestToken,
            existingEvents: before.catalogs[cycle.revision].events };
        });
        let response;
        timing = null;
        const roundStartedAt = Date.now();
        const requested = cycle.targetAdded - cycle.acceptedAdded;
        progress({ requested, error: null });
        try {
          response = await request({ context: prepared.context, count: cycle.targetAdded - cycle.acceptedAdded,
            existingEvents: prepared.existingEvents, requestNumber: cycle.requestsUsed, previousError: lastError,
            onTiming: (next) => { if (isCurrent()) { timing = next; progress({ requested }); } } });
        } catch (error) {
          lastError = error.message || '模型请求或返回格式失败';
          rounds.push({ attempt: cycle.requestsUsed, startedAt: roundStartedAt, endedAt: Date.now(),
            requested, accepted: 0, rejected: 0, error: lastError, timing });
          progress({ error: lastError });
          if (error.retryable === false) break;
          continue;
        }
        let acceptedCount = 0;
        const rejectionReasons = (response.rejected ?? []).flatMap(item => item.errors ?? []);
        const committed = await locked(identity, async () => {
          if (!isCurrent()) throw new Error('聊天已经切换，旧结果已丢弃');
          const record = libraryStore.get(identity);
          if (record?.generationCycle?.cycleId !== cycle.cycleId
            || record.generationCycle.requestToken !== prepared.requestToken
            || record.catalogMutationRevision !== prepared.mutation
            || getBackgroundRevision(identity) !== prepared.revision) {
            throw new Error('事件库或背景已更新，旧结果已丢弃；已有事件保留');
          }
          const catalog = record.catalogs[cycle.revision];
          const seen = new Set(catalog.events.map((event) => event.id));
          const accepted = [];
          const gap = cycle.targetAdded - cycle.acceptedAdded;
          for (const event of response.events ?? []) {
            if (accepted.length >= gap) break;
            const validation = validate(event, response.contextSummary ?? prepared.context);
            if (seen.has(event.id) || !validation.valid) {
              rejectionReasons.push(...(seen.has(event.id) ? ['事件编号重复'] : validation.errors ?? ['事件校验未通过']));
              continue;
            }
            accepted.push(event);
            seen.add(event.id);
          }
          acceptedCount = accepted.length;
          if (!accepted.length) return false;
          await libraryStore.update(identity, (latest) => {
            const target = latest.catalogs[cycle.revision];
            target.events.push(...accepted);
            for (const event of accepted) {
              target.statusByEventId[event.id] = 'generated';
              target.consecutiveUnselectedByEventId[event.id] = 0;
            }
            target.backgroundRevision = prepared.revision;
            target.updatedAt = Date.now();
            if (latest.currentCatalogRevision !== cycle.revision) latest.injectionReceipts = {};
            latest.currentCatalogRevision = cycle.revision;
            latest.pendingCatalogRevision = null;
            latest.generationCycle = { ...cycle, acceptedAdded: cycle.acceptedAdded + accepted.length };
            cycle = latest.generationCycle;
            return latest;
          });
          await onCommit(identity);
          return true;
        });
        lastError = committed ? null : '本轮没有合格的新事件';
        rounds.push({ attempt: cycle.requestsUsed, startedAt: roundStartedAt, endedAt: Date.now(),
          requested, accepted: acceptedCount,
          rejected: (response.rejected?.length ?? 0) + Math.max(0, (response.events?.length ?? 0) - acceptedCount),
          rejectionReasons: [...new Set(rejectionReasons)].slice(0, 12), error: lastError, timing });
        progress({ error: lastError });
      }
      if (cycle.acceptedAdded >= cycle.targetAdded) checkpointStore.clear(identity);
      return { ok: cycle.acceptedAdded >= cycle.targetAdded, partial: cycle.acceptedAdded > 0,
        requestsUsed: cycle.requestsUsed, events: current(identity) ? libraryStore.get(identity)?.events ?? [] : [],
        error: cycle.acceptedAdded < cycle.targetAdded ? `${lastError ?? '本次未补齐'}；已有事件保留，可手动补足` : null };
    } catch (error) {
      return { ok: false, error: error.message, requestsUsed: cycle?.requestsUsed ?? 0 };
    }
  }
  return {
    cancelAll() { epoch += 1; },
    isRunning: (identity) => running.has(catalogIdentityKey(identity)),
    run(identity, trigger) {
      const key = catalogIdentityKey(identity);
      if (running.has(key)) return running.get(key);
      const promise = execute(identity, trigger).finally(() => running.delete(key));
      running.set(key, promise);
      return promise;
    },
  };
}
