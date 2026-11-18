export async function sha256(input) {
  const text = String(input ?? '');

  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(text);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hashBuffer)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

export async function stableHash(value) {
  return sha256(stableStringify(value));
}

export function shortHash(value, length = 12) {
  let hash = 0;
  const text = stableStringify(value);
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, length).padStart(6, '0');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}
