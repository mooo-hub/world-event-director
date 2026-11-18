export async function proxyFetch({ targetUrl, method = 'POST', headers = {}, body = null, fetcher = globalThis.fetch }) {
  const response = await fetcher('/api/plugins/world-event-director/proxy/forward', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetUrl, method, headers, body }),
  });
  if (!response.ok) throw new Error(`Proxy HTTP ${response.status}`);
  return response;
}
