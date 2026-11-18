const DEFAULT_SOFT_TOKEN_LIMIT = 8000;
const DEFAULT_HARD_TOKEN_LIMIT = 12000;
const MAX_HARD_TOKEN_LIMIT = 24000;

export function estimateCatalogInputTokens(messages = []) {
  return messages.reduce((total, message) => {
    const roleTokens = estimateTextTokens(message?.role ?? '');
    const contentTokens = estimateTextTokens(message?.content ?? '');
    const extra = { ...message };
    delete extra.role;
    delete extra.content;
    return total + 4 + roleTokens + contentTokens + estimateTextTokens(JSON.stringify(extra));
  }, 0);
}

export function measureCatalogRequest(messages = [], {
  softTokens = DEFAULT_SOFT_TOKEN_LIMIT,
  hardTokens = DEFAULT_HARD_TOKEN_LIMIT,
} = {}) {
  const hardTokenLimit = clampInteger(hardTokens, DEFAULT_HARD_TOKEN_LIMIT, 1, MAX_HARD_TOKEN_LIMIT);
  const softTokenLimit = clampInteger(softTokens, DEFAULT_SOFT_TOKEN_LIMIT, 1, hardTokenLimit);
  const serializedMessages = JSON.stringify(messages);
  const estimatedTokens = estimateCatalogInputTokens(messages);
  return {
    characterCount: serializedMessages.length,
    estimatedTokens,
    softTokenLimit,
    hardTokenLimit,
    status: estimatedTokens > hardTokenLimit ? 'hard_limit' : estimatedTokens > softTokenLimit ? 'over_soft_limit' : 'ok',
  };
}

export function compileCatalogContext(context = {}, {
  measure = measureDefaultContext,
  softTokens = DEFAULT_SOFT_TOKEN_LIMIT,
  hardTokens = DEFAULT_HARD_TOKEN_LIMIT,
} = {}) {
  const compiled = structuredCloneSafe(context);
  const omissions = [];
  const limits = normalizeLimits(softTokens, hardTokens);
  let metrics = measure(compiled);

  for (const trim of [
    removeLowestPriorityWorldbookEntry,
    removeOldestConversation,
    shortenEntityDescriptions,
    trimAnimaMemory,
    trimPresetPrompts,
    trimCardDetails,
  ]) {
    let changed = true;
    while (changed && readEstimate(metrics) > limits.softTokens) {
      changed = trim(compiled, omissions);
      if (changed) metrics = measure(compiled);
    }
    if (readEstimate(metrics) <= limits.softTokens) break;
  }

  metrics = { ...metrics, softTokenLimit: limits.softTokens, hardTokenLimit: limits.hardTokens };
  metrics.status = readEstimate(metrics) > limits.hardTokens
    ? 'hard_limit'
    : readEstimate(metrics) > limits.softTokens ? 'over_soft_limit' : 'ok';
  if (metrics.status === 'hard_limit') {
    return { ok: false, error: 'catalog_context_too_large', diagnostics: { ...metrics, omissions } };
  }
  return { ok: true, context: compiled, diagnostics: { ...metrics, omissions } };
}

function removeOldestConversation(context, omissions) {
  const block = findBlock(context, 'recent-conversation');
  const messages = parseJsonArray(block?.content);
  if (!block || !messages || messages.length <= 1) return false;
  const removed = messages.shift();
  block.content = JSON.stringify(messages);
  omissions.push({ type: 'recent-conversation', reason: 'older_message', id: removed?.id ?? null });
  return true;
}

function removeLowestPriorityWorldbookEntry(context, omissions) {
  const block = findBlock(context, 'world-background');
  const world = parseJsonObject(block?.content);
  if (!block || !Array.isArray(world?.entries) || !world.entries.length) return false;
  let removedIndex = -1;
  for (let index = world.entries.length - 1; index >= 0; index -= 1) {
    if (!isProtectedWorldbookEntry(world.entries[index], context)) {
      removedIndex = index;
      break;
    }
  }
  if (removedIndex < 0) return false;
  const [removed] = world.entries.splice(removedIndex, 1);
  block.content = JSON.stringify(world);
  const removedId = `${removed.bookId}:${removed.entryId}`;
  context.relevantWorldbookEntries = (context.relevantWorldbookEntries ?? []).filter((entry) => `${entry.bookId}:${entry.entryId}` !== removedId);
  if (context.provenance?.selectedEntryIds) {
    context.provenance.selectedEntryIds = context.provenance.selectedEntryIds.filter((id) => id !== removedId);
  }
  for (const key of ['availableActors', 'availableLocations', 'availableFactions']) {
    if (context.background?.[key]) {
      context.background[key] = context.background[key].filter((entity) => entity.sourceRef?.type !== 'worldbook-entry'
        || `${entity.sourceRef.bookId}:${entity.sourceRef.entryId}` !== removedId);
    }
  }
  omissions.push({ type: 'worldbook-entry', reason: 'lowest_priority', id: removedId });
  return true;
}

function isProtectedWorldbookEntry(entry = {}, context = {}) {
  if (entry.constant || /规则|world\s*rule/i.test(entry.comment ?? '')) return true;
  const sourceKey = `:${entry.bookId}:${entry.entryId}:`;
  return [context.scene?.locationId, ...(context.scene?.presentActorIds ?? [])]
    .filter(Boolean)
    .some((id) => String(id).includes(sourceKey));
}

function shortenEntityDescriptions(context, omissions) {
  for (const key of ['availableActors', 'availableLocations', 'availableFactions']) {
    const entities = context.background?.[key] ?? [];
    const candidate = [...entities].reverse().find((entity) => String(entity.description ?? '').length > 80);
    if (!candidate) continue;
    candidate.description = String(candidate.description).slice(0, 80);
    omissions.push({ type: 'entity-description', reason: 'non_core_detail', id: candidate.id });
    return true;
  }
  return false;
}

function trimAnimaMemory(context, omissions) {
  const block = findBlock(context, 'anima-memory');
  if (!block || String(block.content ?? '').length <= 1200) return false;
  block.content = String(block.content).slice(-1200);
  omissions.push({ type: 'anima-memory', reason: 'older_memory' });
  return true;
}

function trimPresetPrompts(context, omissions) {
  const block = findBlock(context, 'preset-prompts');
  if (!block) return false;
  const prompts = String(block.content ?? '').split(/\n\n+/);
  if (prompts.length <= 1) return false;
  prompts.pop();
  block.content = prompts.join('\n\n');
  omissions.push({ type: 'preset-prompts', reason: 'lower_priority_prompt' });
  return true;
}

function trimCardDetails(context, omissions) {
  for (const type of ['user-card', 'character-card']) {
    const block = findBlock(context, type);
    const card = parseJsonObject(block?.content);
    if (!block || !card || String(card.text ?? '').length <= 500) continue;
    card.text = String(card.text).slice(0, 500);
    block.content = JSON.stringify(card);
    omissions.push({ type, reason: 'card_detail' });
    return true;
  }
  return false;
}

function findBlock(context, type) {
  return context.orderedContextBlocks?.find((block) => block.type === type);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeLimits(softTokens, hardTokens) {
  const hard = clampInteger(hardTokens, DEFAULT_HARD_TOKEN_LIMIT, 1, MAX_HARD_TOKEN_LIMIT);
  return { hardTokens: hard, softTokens: clampInteger(softTokens, DEFAULT_SOFT_TOKEN_LIMIT, 1, hard) };
}

function readEstimate(metrics = {}) {
  return Number(metrics.estimatedTokens ?? metrics.characterCount ?? 0);
}

function measureDefaultContext(context) {
  const serialized = JSON.stringify(context);
  return { characterCount: serialized.length, estimatedTokens: estimateTextTokens(serialized) };
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function estimateTextTokens(value) {
  const text = String(value ?? '');
  const nonAscii = text.match(/[^\x00-\x7f]/gu)?.length ?? 0;
  const ascii = [...text.replace(/[^\x00-\x7f]/g, '')].length;
  return nonAscii + Math.ceil(ascii / 4);
}

function clampInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}
