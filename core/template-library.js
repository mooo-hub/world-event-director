import { normalizeTemplate, validateTemplate } from './event-validator.js';

const EVENT_PACKS = ['daily', 'romance', 'family', 'business', 'security', 'custom'];

export async function loadTemplateLibrary({ baseUrl = import.meta.url, fetcher = globalThis.fetch, logger = console } = {}) {
  const templates = [];
  const errors = [];

  for (const pack of EVENT_PACKS) {
    try {
      const url = new URL(`../events/${pack}.json`, baseUrl);
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const events = Array.isArray(data) ? data : data.events ?? [];
      for (const event of events) {
        const validation = validateTemplate(event);
        if (validation.valid) templates.push({ ...event, pack });
        else errors.push({ pack, id: event?.id, errors: validation.errors });
      }
    } catch (error) {
      errors.push({ pack, errors: [error.message] });
      logger.warn?.(`事件包加载失败：${pack}`, error.message);
    }
  }

  return { templates, errors };
}

export function createTemplateLibrary(initialTemplates = []) {
  let templates = normalizeAccepted(initialTemplates);
  return {
    list: () => templates.map((event) => ({ ...event })),
    replace(nextTemplates) {
      const accepted = [];
      const errors = [];
      for (const event of nextTemplates ?? []) {
        const normalized = normalizeTemplate(event);
        const validation = validateTemplate(normalized);
        if (validation.valid) accepted.push(normalized);
        else errors.push({ id: event?.id, errors: validation.errors });
      }
      templates = accepted;
      return { accepted: accepted.length, errors };
    },
    upsert(event) {
      const normalized = normalizeTemplate(event);
      const validation = validateTemplate(normalized);
      if (!validation.valid) return validation;
      templates = [...templates.filter((item) => item.id !== normalized.id), normalized];
      return { valid: true, errors: [] };
    },
    setEnabled(id, enabled) {
      templates = templates.map((event) => (event.id === id ? { ...event, enabled: Boolean(enabled) } : event));
    },
    setOccurred(id, occurred) {
      templates = templates.map((event) => (event.id === id ? { ...event, occurred: Boolean(occurred) } : event));
    },
  };
}

function normalizeAccepted(events) {
  return (events ?? []).flatMap((event) => {
    const normalized = normalizeTemplate(event);
    return validateTemplate(normalized).valid ? [normalized] : [];
  });
}
