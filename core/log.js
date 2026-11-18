const SENSITIVE_KEYS = new Set(['authorization', 'apikey', 'api_key', 'key', 'token', 'password']);

export function createLogger({ maxEntries = 200, sink = console } = {}) {
  const entries = [];

  function push(level, message, meta = null) {
    const entry = {
      at: new Date().toISOString(),
      level,
      message: String(message),
      meta: sanitizeForLog(meta),
    };
    entries.push(entry);
    while (entries.length > maxEntries) entries.shift();
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    sink?.[method]?.(`[World Event Director] ${entry.message}`, entry.meta ?? '');
    return entry;
  }

  return {
    info: (message, meta) => push('info', message, meta),
    warn: (message, meta) => push('warn', message, meta),
    error: (message, meta) => push('error', message, meta),
    list: () => entries.map((entry) => ({ ...entry })),
    clear: () => entries.splice(0, entries.length),
  };
}

export function sanitizeForLog(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeForLog);

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = '[redacted]';
    } else if (key.toLowerCase().includes('prompt')) {
      result[key] = '[prompt redacted]';
    } else {
      result[key] = sanitizeForLog(child);
    }
  }
  return result;
}

function redactString(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._\-]{8,}/g, 'sk-[redacted]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;}]+/gi, '$1[redacted]');
}
