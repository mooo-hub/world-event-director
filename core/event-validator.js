const REQUIRED_TEMPLATE_FIELDS = [
  'id',
  'title',
  'category',
  'severity',
  'enabled',
  'weight',
  'conditions',
  'presentation',
  'effects',
  'aftermath',
];

const VALID_SEVERITIES = new Set(['ambient', 'normal', 'high', 'critical']);
const DEFAULT_EVENT_PROBABILITIES = Object.freeze({
  ambient: 0.18,
  normal: 0.14,
  high: 0.08,
  critical: 0.04,
});

export function validateTemplate(event) {
  const errors = [];
  if (!event || typeof event !== 'object') return { valid: false, errors: ['事件必须是对象'] };
  event = normalizeTemplate(event);

  for (const field of ['id', 'title', 'category', 'severity', 'enabled', 'weight', 'conditions', 'presentation']) {
    if (!(field in event)) errors.push(`缺少字段：${field}`);
  }
  validateCommonEvent(event, errors);
  if (typeof event.enabled !== 'boolean') errors.push('enabled 必须是布尔值');
  if (!Number.isFinite(Number(event.weight)) || Number(event.weight) <= 0) errors.push('weight 必须是正数');
  if (event.probability !== undefined && (!Number.isFinite(Number(event.probability)) || Number(event.probability) < 0 || Number(event.probability) > 1)) {
    errors.push('probability 必须是 0 到 1 之间的数字');
  }
  if (!event.conditions || typeof event.conditions !== 'object') errors.push('conditions 必须是对象');
  if (!event.presentation || typeof event.presentation !== 'object') errors.push('presentation 必须是对象');
  if (!event.content || typeof event.content !== 'object') errors.push('content 必须是对象');
  if (typeof event.occurred !== 'boolean') errors.push('occurred 必须是布尔值');
  // Keep old template validation for old-format packs while allowing the simplified PRD format.
  if (event.effects || event.aftermath) {
    if (!event.effects || typeof event.effects !== 'object') errors.push('effects 必须是对象');
    if (!event.aftermath || typeof event.aftermath !== 'object') errors.push('aftermath 必须是对象');
  }
  if (event.severity === 'critical' && (event.effects || event.aftermath)) {
    if (Number(event.aftermath?.minTurns ?? 0) < 3) errors.push('critical 事件 aftermath.minTurns 至少为 3');
    if (event.effects?.mustInterrupt !== true) errors.push('critical 事件 effects.mustInterrupt 必须为 true');
    if (!event.effects?.requiredAction) errors.push('critical 事件必须包含 effects.requiredAction');
    if (!event.effects?.userImpact) errors.push('critical 事件必须包含 effects.userImpact');
  }

  return { valid: errors.length === 0, errors };
}

export function validateDirectorDecision(candidate, { context = {}, state = {}, settings = {} } = {}) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') return { valid: false, errors: ['导演输出必须是对象'] };
  if (candidate.shouldTrigger === false) return { valid: true, errors: [] };

  for (const field of ['eventId', 'severity', 'triggerActor', 'triggerSignal', 'requiredAction', 'userImpact']) {
    if (!candidate[field]) errors.push(`导演输出缺少字段：${field}`);
  }
  validateCommonEvent({ ...candidate, id: candidate.eventId, title: candidate.title ?? candidate.eventId }, errors);
  validateBusinessRules(normalizeDecision(candidate), { context, state, settings }, errors);
  return { valid: errors.length === 0, errors };
}

export function validateEvent(candidate, { context = {}, state = {}, settings = {} } = {}) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') return { valid: false, errors: ['事件为空'] };
  validateCommonEvent(candidate, errors);
  validateBusinessRules(candidate, { context, state, settings }, errors);
  return { valid: errors.length === 0, errors };
}

export function normalizeDecision(decision) {
  if (decision?.shouldTrigger === false) return decision;
  return {
    schemaVersion: decision.schemaVersion ?? 1,
    id: decision.eventId ?? decision.id,
    title: decision.title ?? decision.eventId ?? decision.id,
    category: decision.category ?? 'custom',
    severity: decision.severity,
    triggerActor: decision.triggerActor,
    triggerSignal: decision.triggerSignal,
    mustInterrupt: Boolean(decision.mustInterrupt),
    requiredAction: decision.requiredAction,
    cancelCurrentPlan: Boolean(decision.cancelCurrentPlan),
    sceneChange: decision.sceneChange ?? null,
    userImpact: decision.userImpact,
    aftermathTurns: Number(decision.aftermathTurns ?? 2),
    cooldownTurns: Number(decision.cooldownTurns ?? 10),
    reason: decision.reason ?? '',
    source: 'api',
  };
}

export function normalizeTemplate(event) {
  if (!event || typeof event !== 'object') return event;
  return {
    ...event,
    occurred: Boolean(event.occurred),
    content: event.content ?? {
      description: event.detailedDescription ?? event.shortDescription ?? event.description ?? '',
      suggestedImpact: event.effects?.requiredAction ?? '',
      possibleUserImpact: event.effects?.userImpact ?? '',
    },
    probability: Number.isFinite(Number(event.probability))
      ? Number(event.probability)
      : DEFAULT_EVENT_PROBABILITIES[event.severity] ?? 0.1,
  };
}

export function validateCatalogReferences(event, generationContext = {}) {
  const errors = [];
  const actor = event?.trigger?.actor;
  if (!actor?.entityId && actor?.sourceType !== 'environment') errors.push('trigger.actor.entityId 缺失');
  const knownActors = new Set((generationContext.background?.availableActors ?? []).map((item) => item.id));
  if (actor?.entityId && !knownActors.has(actor.entityId)) errors.push(`未知事件发起人：${actor.entityId}`);
  const selected = new Set(generationContext.provenance?.selectedEntryIds ?? []);
  const knownSourceEntries = new Set([
    ...(generationContext.background?.availableActors ?? []),
    ...(generationContext.background?.availableLocations ?? []),
    ...(generationContext.background?.availableFactions ?? []),
  ].flatMap((entity) => entity.sourceRef?.type === 'worldbook-entry'
    ? [`${entity.sourceRef.bookId}:${entity.sourceRef.entryId}`]
    : []));
  for (const ref of event?.sourceRefs ?? []) {
    if (ref.type === 'worldbook-entry') {
      const id = `${ref.bookId}:${ref.entryId}`;
      if (!selected.has(id) && !knownSourceEntries.has(id)) errors.push(`世界书来源不在本次背景中：${id}`);
    }
  }
  if (!event?.sourceRefs?.length) errors.push('sourceRefs 缺失');
  return { valid: errors.length === 0, errors };
}

export function eventFromTemplate(template, { now = Date.now(), random = Math.random } = {}) {
  const signalList = template.presentation?.signals ?? [];
  const signal = template.trigger?.signal ?? signalList[Math.floor(random() * Math.max(1, signalList.length))] ?? '突发消息';
  return {
    schemaVersion: 1,
    id: template.id,
    title: template.title,
    category: template.category,
    impactScope: template.impactScope,
    severity: template.severity,
    probability: Number.isFinite(Number(template.probability)) ? Number(template.probability) : DEFAULT_EVENT_PROBABILITIES[template.severity] ?? 0.1,
    triggerActor: template.trigger?.actor?.name ?? template.presentation?.preferredActor ?? template.conditions?.requiredNpcs?.[0] ?? '外部消息',
    triggerActorRef: template.trigger?.actor ?? null,
    triggerSignal: signal,
    mustInterrupt: template.severity === 'critical' || Boolean(template.effects?.mustInterrupt),
    requiredAction: template.content?.suggestedImpact ?? template.effects?.requiredAction ?? '',
    cancelCurrentPlan: Boolean(template.effects?.cancelCurrentPlan),
    sceneChange: template.effects?.allowLocationChange ? { leaveCurrentScene: true, newLocation: template.effects?.newLocation ?? null } : null,
    userImpact: template.content?.possibleUserImpact ?? template.effects?.userImpact ?? '当前互动会受到影响',
    requiredConsequences: template.effects?.requiredConsequences ?? [],
    impact: template.content?.suggestedImpact ?? template.effects?.requiredAction ?? '',
    relations: template.relations ?? {},
    sourceRefs: template.sourceRefs ?? [],
    reason: `本地模板触发：${template.title}`,
    source: 'template',
    createdAt: now,
  };
}

function validateCommonEvent(event, errors) {
  if (!event.id || !/^[a-zA-Z0-9_.:-]+$/.test(String(event.id))) errors.push('id 必须存在且只能包含字母、数字、下划线、点、冒号或短横线');
  if (!event.title || String(event.title).length > 80) errors.push('title 必须存在且不超过 80 字符');
  if (!VALID_SEVERITIES.has(event.severity)) errors.push('severity 必须是 ambient/normal/high/critical');
}

function validateBusinessRules(event, { context, state, settings }, errors) {
  if (event.severity === 'critical') {
    if (!event.mustInterrupt) errors.push('critical 事件必须 mustInterrupt=true');
    if (!event.requiredAction) errors.push('critical 事件必须包含 requiredAction');
    if (!event.userImpact) errors.push('critical 事件必须包含 userImpact');
    if (event.cancelCurrentPlan && !settings.allowCriticalCancelPlan) errors.push('用户未允许 critical 取消当前计划');
  }
  if (event.severity === 'high' && event.sceneChange?.leaveCurrentScene && settings.allowHighLocationChange === false) {
    errors.push('用户未允许 high 事件改变地点');
  }
  if (!settings.allowUserAsDirectTarget && /用户|{{user}}|你/.test(event.userImpact ?? '') && /遇袭|受伤|绑架|死亡|失踪/.test(event.userImpact ?? '')) {
    errors.push('用户未允许成为事件直接目标');
  }

  const actor = event.triggerActor ?? event.presentation?.preferredActor;
  const environmental = event.triggerActorRef?.sourceType === 'environment' || actor === '环境' || actor === '外部消息';
  if (actor && !environmental && Array.isArray(context.availableNpcs) && context.availableNpcs.length > 0) {
    const known = context.availableNpcs.some((npc) => String(actor).includes(npc) || String(npc).includes(actor));
    const inRecent = (context.recentMessages ?? []).some((message) => String(message.text ?? '').includes(actor));
    if (!known && !inRecent) errors.push(`触发 NPC 不在当前上下文：${actor}`);
  }
}
