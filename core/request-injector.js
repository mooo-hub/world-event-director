export function injectPromptIntoGenerationData(generateData, { prompt, injectionId } = {}) {
  if (!generateData || typeof generateData !== 'object' || !prompt || !injectionId) {
    return { ok: false, reason: 'invalid_input' };
  }

  const payload = generateData.prompt;
  if (typeof payload === 'string') {
    if (payload.includes(injectionId)) return { ok: true, inserted: false, alreadyPresent: true };
    generateData.prompt = `${payload}${payload ? '\n\n' : ''}${prompt}`;
    return { ok: true, inserted: true };
  }

  if (Array.isArray(payload)) {
    if (payload.some((message) => String(message?.content ?? '').includes(injectionId))) {
      return { ok: true, inserted: false, alreadyPresent: true };
    }
    payload.push({ role: 'system', content: prompt });
    return { ok: true, inserted: true };
  }

  return { ok: false, reason: 'unsupported_prompt_shape' };
}

// The host may have compiled a registered extension prompt before settings changed.
// Remove only this receipt's bounded instruction, keeping other request content intact.
export function removeEventPromptFromGenerationData(generateData, injectionId) {
  if (!injectionId) return;
  const remove = (text) => text.replace(/\[WORLD_EVENT_DIRECTOR\][\s\S]*?\[\/WORLD_EVENT_DIRECTOR\]/g,
    (block) => block.split(/\r?\n/).includes(`注入ID：${injectionId}`) ? '' : block);
  if (typeof generateData?.prompt === 'string') {
    generateData.prompt = remove(generateData.prompt);
  } else if (Array.isArray(generateData?.prompt)) {
    generateData.prompt = generateData.prompt.flatMap((message) => {
      if (typeof message?.content !== 'string') return [message];
      const content = remove(message.content);
      if (content === message.content) return [message];
      return content.trim() ? [{ ...message, content }] : [];
    });
  }
}
