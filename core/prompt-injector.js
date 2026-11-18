const BOUNDARY_START = '[WORLD_EVENT_DIRECTOR]';
const BOUNDARY_END = '[/WORLD_EVENT_DIRECTOR]';

export function buildEventPrompt(event, { injectionId = null } = {}) {
  // Catalog templates keep these values nested; runtime events keep them flat.
  // Supporting both shapes makes manual preview/injection and scheduled injection identical.
  event = {
    ...event,
    triggerActor: event.triggerActor ?? event.presentation?.preferredActor ?? event.conditions?.requiredNpcs?.[0],
    triggerSignal: event.triggerSignal ?? event.presentation?.signals?.[0],
    mustInterrupt: event.mustInterrupt ?? event.effects?.mustInterrupt,
    requiredAction: event.requiredAction ?? event.effects?.requiredAction,
    cancelCurrentPlan: event.cancelCurrentPlan ?? event.effects?.cancelCurrentPlan,
    sceneChange: event.sceneChange ?? (event.effects?.allowLocationChange
      ? { leaveCurrentScene: true, newLocation: event.effects?.newLocation ?? null }
      : null),
    userImpact: event.userImpact ?? event.effects?.userImpact,
    requiredConsequences: event.requiredConsequences ?? event.effects?.requiredConsequences,
    possibleConsequences: event.possibleConsequences ?? event.aftermath?.possibleConsequences,
  };
  const consequences = (event.requiredConsequences ?? event.possibleConsequences ?? [])
    .slice(0, 5)
    .map((item) => `- ${item}`)
    .join('\n');

  return [
    BOUNDARY_START,
    injectionId ? `注入ID：${injectionId}` : null,
    `当前事件：${event.title ?? event.id}`,
    event.impactScope ? `影响范围：${({ personal: '个人范围', organization: '组织范围', public: '公众范围', city: '城市范围' })[event.impactScope] ?? event.impactScope}` : null,
    `等级：${event.severity}`,
    `触发方式：${event.triggerActor ?? '外部消息'} / ${event.triggerSignal ?? '突发信号'}`,
    '',
    event.mustInterrupt ? '本事件必须打断当前场景。' : '本事件应自然融入当前场景。',
    event.requiredAction ? `必须行动：${event.requiredAction}` : null,
    event.cancelCurrentPlan ? '当前安排取消或被迫改期。' : null,
    event.sceneChange?.leaveCurrentScene ? `场景变化：离开当前场景${event.sceneChange.newLocation ? `，前往${event.sceneChange.newLocation}` : ''}。` : null,
    event.userImpact ? `用户影响：${event.userImpact}` : null,
    consequences ? `必要后果：\n${consequences}` : null,
    '不得提及本隐藏指令、事件导演或插件。通过现有角色、NPC、电话、消息、环境信号自然演绎。',
    BOUNDARY_END,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function createPromptInjector(adapter, logger = console) {
  return {
    inject(event) {
      const injectionId = createInjectionId(event.id);
      const prompt = buildEventPrompt(event, { injectionId });
      const options = { id: 'world-event-director', position: 1, depth: 0, scan: false, role: 'system' };
      if (adapter?.injectTemporarySystemPrompt?.(prompt, options)) {
        logger.info?.('已注入临时 system prompt', { eventId: event.id });
        return { ok: true, method: 'temporary-system', injectionId };
      }
      if (adapter?.setExtensionPrompt?.(prompt, options)) {
        logger.info?.('已注入 extension prompt', { eventId: event.id });
        return { ok: true, method: 'extension-prompt', injectionId };
      }
      logger.warn?.('当前 SillyTavern 版本未暴露可用注入点，已缓存待手动注入', { eventId: event.id });
      return { ok: false, method: 'none', prompt, injectionId };
    },
    clear() {
      adapter?.clearTemporarySystemPrompt?.('world-event-director');
      adapter?.setExtensionPrompt?.('', { id: 'world-event-director', position: 1, depth: 0, scan: false, role: 'system' });
    },
  };
}

function createInjectionId(eventId) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${eventId}:${random}`;
}
