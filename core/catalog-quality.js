const MIN_DESCRIPTION_CHARACTERS = 50;
const MAX_DESCRIPTION_CHARACTERS = 500;
const MIN_DIRECTION_COUNT = 3;
const MAX_HIGH_SEVERITY_SHARE = 0.4;
const ALLOWED_CATEGORIES = new Set([
  'daily', 'relationship', 'rumor', 'interview', 'career', 'business', 'organization',
  'opportunity', 'threat', 'publicity', 'security', 'family', 'romance',
]);
const ALLOWED_IMPACT_SCOPES = new Set(['personal', 'organization', 'public', 'city']);

export function validateGeneratedCatalog(events = [], { count = 5, requireDetails = true } = {}) {
  const errors = [];
  if (!Array.isArray(events) || events.length !== count) {
    errors.push(`事件数量不符合要求：需要 ${count} 个，实际 ${Array.isArray(events) ? events.length : 0} 个`);
  }

  const candidates = Array.isArray(events) ? events : [];
  const ids = candidates.map((event) => String(event?.id ?? '')).filter(Boolean);
  if (new Set(ids).size !== ids.length) errors.push('事件 ID 重复');

  const directions = new Set(candidates.map((event) => String(event?.category ?? '').trim()).filter(Boolean));
  if (candidates.some((event) => !ALLOWED_CATEGORIES.has(String(event?.category ?? '').trim()))) {
    errors.push('存在不支持的事件方向');
  }
  const requiredDirections = Math.min(MIN_DIRECTION_COUNT, count);
  if (directions.size < requiredDirections) {
    errors.push(`事件方向太集中：至少需要 ${requiredDirections} 个不同方向`);
  }

  const highSeverityCount = candidates.filter((event) => ['high', 'critical'].includes(event?.severity)).length;
  const maxHighSeverity = Math.max(1, Math.floor(count * MAX_HIGH_SEVERITY_SHARE));
  if (highSeverityCount > maxHighSeverity) {
    errors.push(`高等级事件过多：最多 ${maxHighSeverity} 个 high/critical 事件`);
  }
  if (candidates.filter((event) => event?.severity === 'critical').length > 1) {
    errors.push('critical 事件最多 1 个');
  }

  if (candidates.some((event) => !ALLOWED_IMPACT_SCOPES.has(String(event?.impactScope ?? '').trim()))) {
    errors.push('每个事件都必须填写有效的 impactScope（影响范围）');
  }
  if (candidates.length === count && count > 1 && candidates.every((event) => event?.impactScope === 'personal')) {
    errors.push('影响范围太集中：至少需要 1 个超出个人范围的事件');
  }

  for (const [index, event] of candidates.entries()) {
    const description = String(event?.content?.description ?? '').trim();
    const length = [...description].length;
    if (length < MIN_DESCRIPTION_CHARACTERS || length > MAX_DESCRIPTION_CHARACTERS) {
      errors.push(`第 ${index + 1} 个事件描述不够具体或过长：要求 ${MIN_DESCRIPTION_CHARACTERS}-${MAX_DESCRIPTION_CHARACTERS} 个字符`);
    }
    const missingDetails = [
      ['content.suggestedImpact', event?.content?.suggestedImpact],
      ['content.possibleUserImpact', event?.content?.possibleUserImpact],
      ['trigger.actor', event?.trigger?.actor],
      ['trigger.signal', event?.trigger?.signal],
      ['presentation.preferredActor', event?.presentation?.preferredActor],
      ['presentation.signals', event?.presentation?.signals?.length],
      ['relations', event?.relations],
      ['sourceRefs', event?.sourceRefs?.length],
    ].filter(([, value]) => value === undefined || value === null || value === '' || value === 0);
    if (requireDetails && missingDetails.length) {
      errors.push(`第 ${index + 1} 个事件缺少具体字段：${missingDetails.map(([field]) => field).join('、')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// Single-item acceptance permits valid partial results; cross-batch diversity is a prompt preference.
export function validateGeneratedEvent(event, { requireDetails = false } = {}) {
  return validateGeneratedCatalog([event], { count: 1, requireDetails });
}
