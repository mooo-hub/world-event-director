export const EVENT_PHASES = Object.freeze([
  'idle',
  'eligible',
  'pending_injection',
  'triggered',
  'active',
  'aftermath',
  'resolved',
  'failed',
  'expired',
  'cooldown',
]);

const TRANSITIONS = Object.freeze({
  idle: new Set(['eligible', 'pending_injection']),
  eligible: new Set(['pending_injection', 'idle']),
  pending_injection: new Set(['triggered', 'failed', 'expired']),
  triggered: new Set(['active', 'failed', 'expired']),
  active: new Set(['aftermath', 'failed', 'expired']),
  aftermath: new Set(['resolved', 'failed', 'expired']),
  resolved: new Set(['cooldown', 'idle']),
  failed: new Set(['cooldown', 'idle']),
  expired: new Set(['cooldown', 'idle']),
  cooldown: new Set(['idle']),
});

export function createEventStateMachine({ now = () => Date.now() } = {}) {
  return {
    dispatch(state, action) {
      switch (action.type) {
        case 'TRIGGER':
          return triggerEvent(state, action.event, now());
        case 'INJECTION_STARTED':
          return transitionActive(state, 'triggered', now());
        case 'INJECTION_REGISTERED':
          return registerInjection(state, action.injection, now());
        case 'INJECTION_INCLUDED':
          return includeInjection(state, action.injectionId, now());
        case 'MARK_ACTIVE':
          return transitionActive(state, 'active', now());
        case 'ADVANCE':
          return advanceEvent(state, action, now());
        case 'EVALUATE_PROGRESS':
          return applyProgressEvaluation(state, action.progress, now());
        case 'RESOLVE':
          return finishEvent(state, 'resolved', now());
        case 'FAIL':
          return finishEvent(state, 'failed', now());
        case 'EXPIRE':
          return finishEvent(state, 'expired', now());
        case 'PAUSE':
          return { ...state, flags: { ...state.flags, pausedEvent: true } };
        case 'RESUME': {
          const flags = { ...state.flags };
          delete flags.pausedEvent;
          return { ...state, flags };
        }
        case 'EXTEND_AFTERMATH':
          return extendAftermath(state, action.turns ?? 1);
        case 'ABANDON':
          return abandonEvent(state, now());
        default:
          return state;
      }
    },
  };
}

export function triggerEvent(state, event, timestamp = Date.now()) {
  if (!event || state.activeEvent) return state;
  const aftermathTurns = Number(event.aftermathTurns ?? event.aftermath?.minTurns ?? 2);
  const activeEvent = {
    ...event,
    phase: 'pending_injection',
    triggeredTurn: state.turn,
    createdAt: timestamp,
    updatedAt: timestamp,
    remainingAftermathTurns: clamp(aftermathTurns, event.severity === 'critical' ? 3 : 1, 12),
    elapsedTurns: 0,
    injectionCount: 0,
  };
  return {
    ...state,
    activeEvent,
    injection: null,
    lastNoTriggerReason: `已触发事件：${event.title ?? event.id}`,
  };
}

function registerInjection(state, injection, timestamp) {
  if (!state.activeEvent || state.activeEvent.phase !== 'pending_injection' || !injection?.id) return state;
  return {
    ...state,
    injection: {
      id: injection.id,
      eventId: state.activeEvent.id,
      method: injection.method ?? 'extension-prompt',
      status: 'registered',
      registeredAt: timestamp,
    },
  };
}

function includeInjection(state, injectionId, timestamp) {
  if (!state.activeEvent || state.activeEvent.phase !== 'pending_injection' || state.injection?.id !== injectionId) return state;
  return {
    ...transitionActive(state, 'triggered', timestamp),
    injection: { ...state.injection, status: 'included_in_request', includedAt: timestamp },
  };
}

export function advanceEvent(state, action = {}, timestamp = Date.now()) {
  if (!state.activeEvent || state.flags?.pausedEvent) return state;

  const active = {
    ...state.activeEvent,
    elapsedTurns: (state.activeEvent.elapsedTurns ?? 0) + 1,
    updatedAt: timestamp,
  };

  if (active.phase === 'triggered') active.phase = 'active';
  else if (active.phase === 'active' && active.elapsedTurns >= 1) active.phase = 'aftermath';
  else if (active.phase === 'aftermath') active.remainingAftermathTurns = Math.max(0, (active.remainingAftermathTurns ?? 0) - 1);

  const nextState = { ...state, activeEvent: active };
  if (active.phase === 'aftermath' && active.remainingAftermathTurns <= 0) {
    return finishEvent(nextState, 'resolved', timestamp);
  }
  if (action.signal === 'failed') return finishEvent(nextState, 'failed', timestamp);
  if (active.elapsedTurns > 12) return finishEvent(nextState, 'expired', timestamp);
  return nextState;
}

export function transitionActive(state, phase, timestamp = Date.now()) {
  const event = state.activeEvent;
  if (!event || !canTransition(event.phase, phase)) return state;
  return {
    ...state,
    activeEvent: {
      ...event,
      phase,
      updatedAt: timestamp,
      injectionCount: phase === 'triggered' ? (event.injectionCount ?? 0) + 1 : event.injectionCount,
    },
  };
}

export function finishEvent(state, resultPhase, timestamp = Date.now()) {
  const event = state.activeEvent;
  if (!event || !canTransition(event.phase, resultPhase)) return state;
  const finishedEvent = {
    ...event,
    phase: resultPhase,
    finishedAt: timestamp,
    updatedAt: timestamp,
  };
  const cooldownTurns = Number(event.cooldownTurns ?? (event.severity === 'critical' ? 30 : 10));
  return {
    ...state,
    activeEvent: null,
    eventHistory: [...(state.eventHistory ?? []), finishedEvent].slice(-50),
    cooldowns: {
      ...(state.cooldowns ?? {}),
      [event.id]: (state.turn ?? 0) + cooldownTurns,
      [`severity:${event.severity}`]: (state.turn ?? 0) + Math.ceil(cooldownTurns / 2),
    },
    lastNoTriggerReason: `事件进入冷却：${event.title ?? event.id}`,
  };
}

export function extendAftermath(state, turns = 1) {
  if (!state.activeEvent) return state;
  return {
    ...state,
    activeEvent: {
      ...state.activeEvent,
      phase: state.activeEvent.phase === 'active' ? 'aftermath' : state.activeEvent.phase,
      remainingAftermathTurns: Math.min(12, (state.activeEvent.remainingAftermathTurns ?? 0) + Number(turns)),
    },
  };
}

export function abandonEvent(state, timestamp = Date.now()) {
  if (!state.activeEvent) return state;
  const abandoned = {
    ...state.activeEvent,
    phase: 'failed',
    finishedAt: timestamp,
    abandoned: true,
  };
  return {
    ...state,
    activeEvent: null,
    eventHistory: [...(state.eventHistory ?? []), abandoned].slice(-50),
    lastNoTriggerReason: '用户放弃了当前事件',
  };
}

export function applyProgressEvaluation(state, progress, timestamp = Date.now()) {
  const active = state.activeEvent;
  if (!active || !progress || progress.eventId !== active.id) return state;
  const status = progress.status;
  if (!['triggered', 'active', 'aftermath', 'resolved', 'failed', 'expired'].includes(status)) return state;

  if (status === 'resolved' || status === 'failed' || status === 'expired') {
    const staged = {
      ...state,
      activeEvent: {
        ...active,
        phase: 'aftermath',
        remainingAftermathTurns: 0,
        progressReason: progress.reason ?? '',
        updatedAt: timestamp,
      },
    };
    return finishEvent(staged, status, timestamp);
  }

  return {
    ...state,
    activeEvent: {
      ...active,
      phase: status,
      progressReason: progress.reason ?? '',
      updatedAt: timestamp,
    },
  };
}

export function canTransition(from, to) {
  return TRANSITIONS[from]?.has(to) ?? false;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
