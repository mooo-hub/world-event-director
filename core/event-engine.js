import { eventFromTemplate, validateEvent } from './event-validator.js';

const SEVERITY_ORDER = ['critical', 'high', 'normal', 'ambient'];

export function createEventEngine({ templates = [], random = Math.random } = {}) {
  return {
    evaluate({ context, state, settings, now = Date.now() }) {
      if (!settings.enabled) return noTrigger('插件未启用');
      if (settings.paused) return noTrigger('调度已暂停');

      const simpleInterval = Number(settings.eventCheckInterval ?? 0);
      if (simpleInterval > 0) {
        if ((state.turn ?? 0) - Number(state.lastEventCheckTurn ?? 0) < simpleInterval) return noTrigger('未到检查间隔');
        const candidates = templates.filter((template) => isCandidateAllowed(template, { context, state, settings }));
        if (candidates.length === 0) return noTrigger('没有未发生且满足条件的事件');
        const selected = weightedPick(candidates, random);
        const selection = { candidateIds: candidates.map((event) => event.id), selectedId: selected.id };
        const probabilityHit = shouldRoll(selected, settings, random);
        if (!probabilityHit.ok) return { ...noTrigger(`概率未命中：${probabilityHit.reason}`), ...selection };
        const event = eventFromTemplate(selected, { now, random });
        const validation = validateEvent(event, { context, state, settings });
        return validation.valid
          ? { shouldTrigger: true, event, source: 'template', ...selection }
          : { ...noTrigger(`候选事件校验失败：${validation.errors.join('；')}`), ...selection };
      }

      const dueSeverities = SEVERITY_ORDER.filter((severity) => isSeverityDue(severity, state, settings));
      if (dueSeverities.length === 0) return noTrigger('未到检查间隔');

      const candidates = templates.filter((template) => dueSeverities.includes(template.severity) && isCandidateAllowed(template, { context, state, settings }));
      if (candidates.length === 0) return noTrigger('没有满足条件的候选事件', dueSeverities);

      const selected = weightedPick(candidates, random);
      const selection = { candidateIds: candidates.map((event) => event.id), selectedId: selected.id };
      const probabilityHit = shouldRoll(selected, settings, random);
      if (!probabilityHit.ok) return { ...noTrigger(`概率未命中：${probabilityHit.reason}`, dueSeverities), ...selection };

      if (!settings.templateEventsEnabled) return noTrigger('候选事件已关闭', dueSeverities);
      const event = eventFromTemplate(selected, { now, random });
      const validation = validateEvent(event, { context, state, settings });
      if (!validation.valid) return { ...noTrigger(`候选事件校验失败：${validation.errors.join('；')}`, dueSeverities), ...selection };
      return { shouldTrigger: true, event, source: 'template', checkedSeverities: dueSeverities, ...selection };
    },
  };
}

export function isSeverityDue(severity, state, settings) {
  if (severity === 'critical' && !settings.autoCritical) return false;
  const interval = Number(settings.intervals?.[severity] ?? 5);
  const lastTurn = Number(state.lastCheckedTurns?.[severity] ?? 0);
  return (state.turn ?? 0) - lastTurn >= interval;
}

export function isCandidateAllowed(template, { context, state, settings }) {
  if (!template.enabled) return false;
  if (template.status ? template.status !== 'generated' : template.occurred) return false;
  if (template.severity === 'critical' && !settings.autoCritical) return false;
  if ((state.cooldowns?.[template.id] ?? 0) > (state.turn ?? 0)) return false;
  if ((state.cooldowns?.[`severity:${template.severity}`] ?? 0) > (state.turn ?? 0)) return false;
  const conditions = template.conditions ?? {};
  if (conditions.blockedIfActiveEvent && state.activeEvent) return false;
  if (conditions.minTurnsSinceLastCritical && template.severity === 'critical') {
    const lastCritical = lastSeverityTurn(state, 'critical');
    if ((state.turn ?? 0) - lastCritical < Number(conditions.minTurnsSinceLastCritical)) return false;
  }
  if (conditions.requiredNpcs?.length) {
    const known = new Set(context.availableNpcs ?? []);
    const recentText = (context.recentMessages ?? []).map((message) => message.text).join('\n');
    const hasNpc = conditions.requiredNpcs.some((npc) => known.has(npc) || recentText.includes(npc));
    if (!hasNpc) return false;
  }
  const requiredActorIds = conditions.requiredActorIds ?? conditions.requiredNpcIds ?? [];
  if (requiredActorIds.length) {
    const knownActorIds = new Set(context.backgroundContext?.entities?.actors?.map((actor) => actor.id) ?? []);
    if (!requiredActorIds.every((id) => knownActorIds.has(id))) return false;
  }
  if (conditions.requiredWorldTags?.length) {
    const worldTags = new Set((context.worldbooks ?? []).flatMap((book) => book.tags ?? []));
    const worldText = (context.worldbooks ?? []).map((book) => `${book.name} ${book.summary} ${book.text}`).join('\n');
    const hasTag = conditions.requiredWorldTags.some((tag) => worldTags.has(tag) || worldText.toLowerCase().includes(String(tag).toLowerCase()));
    if (!hasTag) return false;
  }
  return true;
}

function shouldRoll(event, settings, random) {
  const base = Number(event.probability ?? settings.probabilities?.[event.severity] ?? 0.1);
  const chance = Math.max(0, Math.min(1, base));
  const roll = random();
  return { ok: roll < chance, reason: `${event.id}: ${Math.round(roll * 100)} >= ${Math.round(chance * 100)}` };
}

function weightedPick(items, random) {
  const adjustedWeight = (item) => Number(item.weight ?? 1) * unselectedWeightMultiplier(item.consecutiveUnselected);
  const total = items.reduce((sum, item) => sum + adjustedWeight(item), 0);
  let target = random() * total;
  for (const item of items) {
    target -= adjustedWeight(item);
    if (target <= 0) return item;
  }
  return items.at(-1);
}

export function unselectedWeightMultiplier(count = 0) {
  return [1, 1.2, 1.5, 2][Math.min(3, Math.max(0, Math.floor(Number(count) || 0)))];
}

function lastSeverityTurn(state, severity) {
  const events = state.eventHistory ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].severity === severity) return events[index].triggeredTurn ?? 0;
  }
  return 0;
}

function noTrigger(reason, checkedSeverities = []) {
  return { shouldTrigger: false, reason, checkedSeverities };
}
