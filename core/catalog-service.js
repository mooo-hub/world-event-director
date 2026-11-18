export async function generateCatalogTransaction({
  identity,
  contextRevision,
  expectedCount = null,
  getCurrentIdentity,
  getCurrentContextRevision,
  generate,
  validate,
  commit,
}) {
  let events;
  try {
    events = await generate();
  } catch (error) {
    return {
      ok: false,
      stage: 'request',
      error: error.message,
      errorDetails: {
        failureKind: error.failureKind,
        schemaRejected: error.schemaRejected,
        referenceRejected: error.referenceRejected,
        attempts: error.attempts,
        schemaErrorCounts: error.schemaErrorCounts,
        referenceErrorCounts: error.referenceErrorCounts,
      },
    };
  }
  if (Number.isInteger(expectedCount) && events.length !== expectedCount) {
    return { ok: false, stage: 'count', error: `expected_${expectedCount}_events_received_${events.length}` };
  }
  if (!sameIdentity(identity, getCurrentIdentity?.())) return { ok: false, stage: 'identity', error: 'identity_changed' };
  if (String(contextRevision ?? '') !== String(getCurrentContextRevision?.() ?? '')) return { ok: false, stage: 'context', error: 'context_changed' };
  const rejectedEvents = [];
  for (let index = 0; index < (events ?? []).length; index += 1) {
    const result = validate(events[index], index);
    if (!result.valid) rejectedEvents.push({ index, id: events[index]?.id, errors: result.errors ?? [] });
  }
  if (rejectedEvents.length) return { ok: false, stage: 'validate', rejectedEvents };
  try {
    await commit(events);
    return { ok: true, events };
  } catch (error) {
    return { ok: false, stage: 'persist', error: error.message };
  }
}

function sameIdentity(left = {}, right = {}) {
  return ['chatId', 'branchId', 'characterId'].every((key) => String(left?.[key] ?? '') === String(right?.[key] ?? ''));
}
