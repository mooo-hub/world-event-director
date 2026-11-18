const DEFAULT_SCENE = Object.freeze({
  time: null,
  location: null,
  plan: null,
  actors: [],
});

export function createEmptyContext() {
  return {
    character: null,
    worldbooks: [],
    backgroundContext: null,
    sceneContext: createEmptySceneContext(),
    recentMessages: [],
    scene: { ...DEFAULT_SCENE },
    availableNpcs: [],
    worldbookHash: '',
    syncedAt: 0,
  };
}

export function createContextCache(initialContext = null) {
  let snapshot = initialContext ? normalizeContext(initialContext) : createEmptyContext();

  return {
    get: () => structuredCloneSafe(snapshot),
    replace(nextContext) {
      snapshot = normalizeContext(nextContext);
      return this.get();
    },
    mergeDelta(delta = {}) {
      const messages = [...(snapshot.recentMessages ?? []), ...(delta.messages ?? [])];
      const recentMessages = dedupeMessages(messages).slice(-30);
      snapshot = normalizeContext({
        ...snapshot,
        recentMessages,
        scene: mergeScene(snapshot.scene, inferSceneFromMessages(delta.messages ?? [])),
        sceneContext: updateSceneContext(snapshot.sceneContext, delta.messages ?? [], snapshot.backgroundContext),
        availableNpcs: snapshot.backgroundContext?.entities?.actors
          ?.filter((actor) => actor.type === 'npc').map((actor) => actor.name) ?? snapshot.availableNpcs,
        syncedAt: Date.now(),
      });
      return this.get();
    },
  };
}

export function normalizeContext(context = {}) {
  const recentMessages = dedupeMessages(context.recentMessages ?? []).slice(-30);
  const inferredScene = inferSceneFromMessages(recentMessages);
  return {
    character: context.character ?? null,
    worldbooks: Array.isArray(context.worldbooks) ? context.worldbooks : [],
    backgroundContext: context.backgroundContext ?? null,
    userPersona: context.userPersona ?? null,
    preset: context.preset ?? null,
    sceneContext: context.sceneContext ?? updateSceneContext({}, recentMessages, context.backgroundContext),
    recentMessages,
    scene: mergeScene(DEFAULT_SCENE, context.scene ?? { ...inferredScene, time: context.sceneContext?.time ?? inferredScene.time }),
    availableNpcs: context.backgroundContext?.entities?.actors
      ?.filter((actor) => actor.type === 'npc').map((actor) => actor.name)
      ?? context.availableNpcs ?? [],
    worldbookHash: context.worldbookHash ?? '',
    syncedAt: context.syncedAt ?? Date.now(),
    identity: context.identity ?? null,
    cacheStatus: context.cacheStatus ?? 'fresh',
  };
}

export function buildContextSummary(context = {}) {
  if (context.backgroundContext) {
    const generated = buildEventGenerationContext({ context, state: {}, existingEvents: [] });
    if (generated.ok) return generated.value;
  }
  const character = context.character?.summary || context.character?.text || context.character?.name || '未知角色';
  const worldbooks = (context.worldbooks ?? [])
    .map((book) => `${book.name || book.id}: ${book.summary || book.text || ''}`.trim())
    .filter(Boolean)
    .slice(0, 8);
  const recent = (context.recentMessages ?? [])
    .slice(-8)
    .map((message) => `${message.role}: ${message.text}`)
    .join('\n');

  return {
    character,
    worldbooks,
    recent,
    scene: context.scene ?? DEFAULT_SCENE,
    availableNpcs: context.availableNpcs ?? [],
  };
}

export async function buildBackgroundContext({ character, worldbooks = [] } = {}) {
  if (!character?.name) return null;
  const actors = [{
    id: `character:${character.id}`,
    type: 'character',
    name: character.name,
    aliases: [],
    description: character.summary ?? '',
    sourceRef: { type: 'character-card', characterId: String(character.id) },
  }];
  const locations = [];
  const factions = [];
  const items = [];
  const worldbookEntries = [];
  const rules = [];
  const animaMemoryEntries = [];

  for (const book of worldbooks) {
    for (const entry of book.entries ?? []) {
      if (entry.enabled === false || !entry.content) continue;
      const sourceRef = { type: 'worldbook-entry', bookId: String(book.id), entryId: String(entry.id) };
      const normalized = { ...entry, bookId: String(book.id), sourceRef };
      worldbookEntries.push(normalized);
      if (isAnimaMemoryEntry(book, entry)) animaMemoryEntries.push(normalized);
      for (const name of extractAttributeNames(entry.content, 'character_information', 'character')) {
        actors.push({ id: `npc:${book.id}:${entry.id}:${slug(name)}`, type: 'npc', name, aliases: entry.keys ?? [], description: summarizeText(entry.content, 500), sourceRef });
      }
      for (const name of extractAttributeNames(entry.content, 'location', 'name')) {
        locations.push({ id: `location:${book.id}:${entry.id}:${slug(name)}`, type: 'location', name, aliases: entry.keys ?? [], description: summarizeText(entry.content, 500), sourceRef });
      }
      if (!isAnimaMemoryEntry(book, entry) && (entry.constant || /规则|背景|设定|world/i.test(entry.comment ?? ''))) rules.push(entry.content);
    }
  }

  return {
    character: { ...actors[0], summary: character.summary ?? '', text: character.text ?? '' },
    world: { summary: summarizeText(rules.join('\n'), 3000), rules: rules.map((rule) => summarizeText(rule, 1200)), themes: [] },
    entities: {
      actors: dedupeEntities(actors), locations: dedupeEntities(locations), factions, items,
    },
    worldbookEntries,
    animaMemoryEntries,
    revision: {
      characterHash: character.hash ?? '',
      worldbookHash: worldbooks.map((book) => book.hash ?? '').join(':'),
      builtAt: Date.now(),
    },
  };
}

export function updateSceneContext(previous = {}, messages = [], backgroundContext = null) {
  const base = { ...createEmptySceneContext(), ...(previous ?? {}) };
  const cleanMessages = sanitizeConversationMessages(messages);
  const inferred = inferSceneFromMessages(cleanMessages);
  const facts = [...(base.establishedFacts ?? [])];
  const promises = [...(base.pendingPromises ?? [])];
  for (const message of cleanMessages) {
    const sentences = String(message.text ?? '').split(/[。！？!?\n]/).map((item) => item.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (/答应|约定|承诺|决定|不会|不能|必须|已经|成为|离开|到达|正在/.test(sentence)) facts.push(sentence);
      if (/答应|约定|承诺/.test(sentence)) promises.push(sentence);
    }
  }
  return {
    ...base,
    time: inferred.time ?? base.time,
    locationId: resolveLocationId(inferred.location, backgroundContext) ?? base.locationId,
    presentActorIds: resolveActorIds(inferred.actors, backgroundContext, base.presentActorIds),
    currentPlan: inferred.plan ?? base.currentPlan,
    establishedFacts: mergeUnique(facts).slice(-100),
    pendingPromises: mergeUnique(promises).slice(-30),
    updatedThroughMessageId: messages.at(-1)?.id ?? base.updatedThroughMessageId,
    revision: `${messages.at(-1)?.id ?? base.updatedThroughMessageId ?? 'empty'}:${facts.length}`,
  };
}

export function buildEventGenerationContext({ context = {}, state = {}, existingEvents = [] } = {}) {
  const background = context.backgroundContext;
  if (!background?.character || !background?.revision) return { ok: false, error: 'background_unavailable' };
  const recentConversation = sanitizeConversationMessages(context.recentMessages ?? []).slice(-30);
  const scene = context.sceneContext ?? createEmptySceneContext();
  const searchable = [
    scene.locationId,
    ...(scene.presentActorIds ?? []),
    ...(scene.establishedFacts ?? []),
    ...recentConversation.map((message) => message.text),
  ].filter(Boolean).join('\n').toLowerCase();
  const memoryIds = new Set((background.animaMemoryEntries ?? []).map((entry) => `${entry.bookId}:${entry.id}`));
  const sceneEntityIds = new Set([scene.locationId, ...(scene.presentActorIds ?? [])].filter(Boolean));
  const sceneSourceRefs = [...(background.entities?.actors ?? []), ...(background.entities?.locations ?? [])]
    .filter((entity) => sceneEntityIds.has(entity.id))
    .map((entity) => entity.sourceRef)
    .filter(Boolean);
  const relevantWorldbookEntries = (background.worldbookEntries ?? []).filter((entry) => !memoryIds.has(`${entry.bookId}:${entry.id}`))
    .map((entry) => ({ entry, score: scoreEntry(entry, searchable, scene, sceneSourceRefs) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || Number(right.entry.order ?? 0) - Number(left.entry.order ?? 0))
    .map(({ entry }) => ({
      bookId: entry.bookId, entryId: entry.id, comment: entry.comment, keys: entry.keys,
      constant: entry.constant, content: entry.content, sourceRef: entry.sourceRef,
    }));
  const value = {
    contextSchemaVersion: 1,
    backgroundRevision: `${background.revision.characterHash}:${background.revision.worldbookHash}:${background.revision.presetHash ?? ''}:${background.revision.userHash ?? ''}`,
    background: {
      character: background.character,
      worldSummary: '',
      worldRules: [],
      availableActors: filterEntitiesBySources(background.entities?.actors, relevantWorldbookEntries),
      availableLocations: filterEntitiesBySources(background.entities?.locations, relevantWorldbookEntries),
      availableFactions: filterEntitiesBySources(background.entities?.factions, relevantWorldbookEntries),
    },
    relevantWorldbookEntries,
    scene,
    recentConversation,
    eventMemory: {
      activeEvent: state.activeEvent ?? null,
      recentHistory: (state.eventHistory ?? []).slice(-10),
      existingEventIds: existingEvents.map((event) => event.id),
    },
    provenance: {
      backgroundCache: context.cacheStatus ?? 'fresh',
      sceneRevision: scene.revision ?? '',
      selectedEntryIds: relevantWorldbookEntries.map((entry) => `${entry.bookId}:${entry.entryId}`),
    },
  };
  value.orderedContextBlocks = buildOrderedContextBlocks({
    background: { ...background, world: { ...background.world, summary: '', rules: [] } },
    recentConversation,
    relevantWorldbookEntries,
    scene,
    preset: context.preset,
    userPersona: context.userPersona,
  });
  return { ok: true, value };
}

export function sanitizeConversationMessages(messages = []) {
  return messages.map((message) => ({ ...message, text: stripInjectedPromptSuffix(message.text) }));
}

function buildOrderedContextBlocks({ background, recentConversation, relevantWorldbookEntries, scene, preset, userPersona }) {
  const memory = (background.animaMemoryEntries ?? []).map((entry) => entry.content).join('\n\n');
  const recent = JSON.stringify(recentConversation.map(({ role, text, id, turn }) => ({ role, text, id, turn })));
  const world = JSON.stringify({
    summary: background.world?.summary ?? '',
    rules: background.world?.rules ?? [],
    entries: relevantWorldbookEntries,
  });
  const prompts = (preset?.prompts ?? []).map((prompt) => `[${prompt.role}] ${prompt.name}\n${prompt.content}`).join('\n\n');
  return [
    { type: 'anima-memory', content: memory },
    { type: 'recent-conversation', content: recent },
    { type: 'world-background', content: world },
    { type: 'dynamic-scene', content: JSON.stringify(scene) },
    { type: 'preset-prompts', content: prompts },
    { type: 'character-card', content: JSON.stringify({
      name: background.character?.name ?? '',
      summary: background.character?.summary ?? '',
      text: background.character?.text ?? '',
    }) },
    { type: 'user-card', content: JSON.stringify({
      name: userPersona?.name ?? '',
      summary: userPersona?.summary ?? '',
      text: userPersona?.text ?? '',
    }) },
  ];
}

function dedupeMessages(messages) {
  const seen = new Set();
  const result = [];
  for (const message of messages) {
    if (!message?.id || seen.has(message.id)) continue;
    seen.add(message.id);
    result.push(message);
  }
  return result.sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0));
}

function inferSceneFromMessages(messages) {
  const text = messages.map((message) => message.text || '').join('\n').slice(-6000);
  const locationMatch = text.match(/(?:在|抵达|回到|前往|进入)([\u4e00-\u9fa5A-Za-z0-9]{2,16}(?:集团|总部|山庄|公寓|学校|酒吧|餐厅|办公室|医院|庄园|街区|大厅|房间|车库|港口))/);
  const timeMatches = [...text.matchAll(/(?:清晨|早上|上午|中午|下午|傍晚|晚上|深夜|凌晨|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}:\d{2})/g)];
  const timeMatch = timeMatches.at(-1);
  const planMatch = text.match(/(?:计划|安排|约定|准备|打算)([^。！？\n]{2,42})/);
  const actors = [...new Set((text.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [])
    .filter((name) => !COMMON_WORDS.has(name))
    .slice(-8))];

  return {
    time: timeMatch?.[0] ?? null,
    location: locationMatch?.[1] ?? null,
    plan: planMatch?.[1]?.trim() ?? null,
    actors,
  };
}

function inferNpcNames(context, messages) {
  const text = [
    context.character?.text,
    ...(context.worldbooks ?? []).map((book) => book.text),
    ...(messages ?? []).map((message) => message.text),
  ]
    .filter(Boolean)
    .join('\n');

  const names = text.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [];
  return names.filter((name) => !COMMON_WORDS.has(name)).slice(-30);
}

function mergeScene(left = {}, right = {}) {
  return {
    time: right.time ?? left.time ?? null,
    location: right.location ?? left.location ?? null,
    plan: right.plan ?? left.plan ?? null,
    actors: mergeUnique(left.actors ?? [], right.actors ?? []).slice(-12),
  };
}

function mergeUnique(...lists) {
  return [...new Set(lists.flat().filter(Boolean).map(String))];
}

function createEmptySceneContext() {
  return {
    time: null,
    locationId: null,
    presentActorIds: [],
    currentPlan: null,
    unresolvedConflicts: [],
    relationshipChanges: [],
    establishedFacts: [],
    pendingPromises: [],
    updatedThroughMessageId: null,
    revision: '',
  };
}

function extractAttributeNames(content, tag, attribute) {
  const pattern = new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, 'gi');
  return [...String(content ?? '').matchAll(pattern)].map((match) => match[1].trim()).filter(Boolean);
}

function slug(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
}

function dedupeEntities(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.type}:${String(item.name).toLowerCase()}`;
    return item.id && !seen.has(key) && seen.add(key);
  });
}

function resolveLocationId(name, background) {
  if (!name) return null;
  return background?.entities?.locations?.find((location) => location.name === name || location.aliases?.includes(name))?.id ?? null;
}

function resolveActorIds(names = [], background, previous = []) {
  const ids = names.flatMap((name) => background?.entities?.actors
    ?.filter((actor) => actor.name === name || actor.aliases?.includes(name)).map((actor) => actor.id) ?? []);
  return mergeUnique(previous, ids).slice(-20);
}

function scoreEntry(entry, searchable, scene, sceneSourceRefs = []) {
  const isRule = /规则|world\s*rule/i.test(entry.comment ?? '');
  let score = entry.constant || isRule ? 1000 : 0;
  if (scene.locationId && String(scene.locationId).includes(`:${entry.bookId}:${entry.id}:`)) score += 200;
  if (sceneSourceRefs.some((source) => source.bookId === entry.bookId && source.entryId === String(entry.id))) score += 200;
  for (const key of entry.keys ?? []) {
    const normalizedKey = String(key).trim().toLowerCase();
    if (normalizedKey && searchable.includes(normalizedKey)) score += 100;
  }
  return score;
}

function filterEntitiesBySources(entities = [], entries = []) {
  const selected = new Set(entries.map(({ bookId, entryId }) => `${bookId}:${entryId}`));
  return (entities ?? []).filter((entity) => entity.sourceRef?.type !== 'worldbook-entry'
    || selected.has(`${entity.sourceRef.bookId}:${entity.sourceRef.entryId}`));
}

function summarizeText(text, maxLength) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isAnimaMemoryEntry(book = {}, entry = {}) {
  const marker = [book.name, entry.comment, ...(entry.keys ?? []), entry.automationId, entry.source]
    .filter(Boolean).join(' ');
  return /anima|记忆(?:总结|摘要|归档)|memory\s*(?:summary|digest)/i.test(marker);
}

function stripInjectedPromptSuffix(text) {
  let value = String(text ?? '');
  const markers = [
    /\n\s*#\s*核心指令[:：]/i,
    /\n\s*normal_sex_scenario\s*:/i,
    /\n\s*【内部隐性自检规则/i,
    /\n\s*\[WORLD_EVENT_DIRECTOR\]/i,
  ];
  let cut = value.length;
  for (const marker of markers) {
    const match = marker.exec(value);
    if (match && match.index < cut) cut = match.index;
  }
  return value.slice(0, cut).trim();
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

const COMMON_WORDS = new Set([
  '用户', '角色', '当前', '世界', '事件', '回复', '消息', '地点', '时间', '关系', '计划', '安排',
  '他们', '我们', '你们', '自己', '这个', '那个', '没有', '知道', '继续', '突然', '已经', '因为',
]);
