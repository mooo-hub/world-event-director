const { ProxyAgent } = require('undici');

let stProxyConfig = {
  enabled: false,
  url: '',
  bypass: ['localhost', '127.0.0.1'],
};

function init(router) {
  router.post('/proxy/forward', async (req, res) => {
    const { targetUrl, method = 'POST', headers = {}, body } = req.body ?? {};
    if (!targetUrl) return res.status(400).json({ error: 'Missing targetUrl' });

    try {
      const fetchOptions = {
        method,
        headers: redactInboundHeaders(headers),
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      };

      if (shouldUseProxy(targetUrl)) {
        fetchOptions.dispatcher = new ProxyAgent(stProxyConfig.url);
      }

      const response = await fetch(targetUrl, fetchOptions);
      const text = await response.text();
      res.status(response.status).type(response.headers.get('content-type') ?? 'application/json').send(text);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/proxy/config', (req, res) => {
    const next = req.body ?? {};
    stProxyConfig = {
      enabled: Boolean(next.enabled),
      url: String(next.url ?? ''),
      bypass: Array.isArray(next.bypass) ? next.bypass.map(String) : stProxyConfig.bypass,
    };
    res.json({ ok: true, enabled: stProxyConfig.enabled, bypass: stProxyConfig.bypass });
  });

  console.log('[World Event Director] optional server proxy started');
}

function shouldUseProxy(targetUrl) {
  if (!stProxyConfig.enabled || !stProxyConfig.url) return false;
  return !stProxyConfig.bypass.some((item) => targetUrl.includes(item));
}

function redactInboundHeaders(headers) {
  const result = { ...headers };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'host') delete result[key];
  }
  return result;
}

module.exports = {
  init,
  exit: async () => {},
  info: {
    id: 'world-event-director',
    name: 'World Event Director Proxy',
    description: 'Optional proxy route for the World Event Director UI extension.',
  },
};
