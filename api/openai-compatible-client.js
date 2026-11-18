import {
  buildDirectorSystemPrompt,
  buildDirectorUserPrompt,
  buildEventCatalogSystemPrompt,
  buildEventCatalogUserPrompt,
} from './model-response-schema.js';
import { sanitizeForLog } from '../core/log.js';
import { normalizeTemplate, validateCatalogReferences, validateTemplate } from '../core/event-validator.js';
import { validateGeneratedEvent } from '../core/catalog-quality.js';


export async function requestDirectorDecision({ settings, contextSummary, stateSummary, candidates, fetcher = globalThis.fetch, logger = console }) {
  const api = settings?.api ?? {};
  if (!api.apiKey) throw new Error('API Key missing');
  if (!api.baseUrl) throw new Error('API Base URL missing');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(api.timeoutMs ?? 8000));
  const url = `${normalizeBaseUrl(api.baseUrl)}/chat/completions`;
  const payload = {
    model: api.model,
    temperature: Number(api.temperature ?? 0.2),
    max_tokens: Number(api.maxTokens ?? 800),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildDirectorSystemPrompt(settings) },
      { role: 'user', content: buildDirectorUserPrompt({ contextSummary, stateSummary, candidates }) },
    ],
  };

  logger.info?.('调用事件导演 API', sanitizeForLog({ url, model: api.model, candidates: candidates.length }));

  try {
    const response = await performFetch({ fetcher, url, api, payload, signal: controller.signal });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API HTTP ${response.status}: ${text.slice(0, 160)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('API response missing choices[0].message.content');
    return parseJsonObject(content);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('事件导演 API 请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function performFetch({ fetcher, url, api, payload, signal }) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${api.apiKey}`,
  };

  if (api.connectionMode === 'proxy') {
    return fetcher('/api/plugins/world-event-director/proxy/forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: url,
        method: 'POST',
        headers,
        body: payload,
      }),
      signal,
    });
  }

  return fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
}

export async function testDirectorConnection({ settings, fetcher = globalThis.fetch }) {
  const api = settings?.api ?? {};
  if (!api.baseUrl) throw new Error('API Base URL missing');
  if (!api.apiKey) throw new Error('API Key missing');
  if (!api.model) throw new Error('Model missing');
  const health = {
    models: { status: 'unknown' },
    completion: { status: 'unknown' },
    schema: { status: 'unknown' },
  };
  const modelsUrl = `${normalizeBaseUrl(api.baseUrl)}/models`;
  const started = Date.now();
  try {
    const modelResponse = await withTimeout(
      (signal) => fetchWithApi({ fetcher, url: modelsUrl, api, method: 'GET', signal }),
      Number(api.timeoutMs ?? 8000),
    );
    health.models = {
      status: modelResponse.ok ? 'pass' : [404, 405].includes(modelResponse.status) ? 'unsupported' : 'fail',
      httpStatus: modelResponse.status,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    health.models = { status: 'fail', message: error.message, latencyMs: Date.now() - started };
  }

  const payload = {
    model: api.model,
    temperature: 0,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Return exactly {"ok":true} as JSON.' }],
  };
  const completionStarted = Date.now();
  try {
    const response = await withTimeout(
      (signal) => performFetch({ fetcher, url: `${normalizeBaseUrl(api.baseUrl)}/chat/completions`, api, payload, signal }),
      Number(api.timeoutMs ?? 8000),
    );
    if (!response.ok) {
      health.completion = { status: 'fail', httpStatus: response.status, latencyMs: Date.now() - completionStarted };
      health.schema = { status: 'skipped' };
      return { ok: false, health };
    }
    health.completion = { status: 'pass', httpStatus: response.status, latencyMs: Date.now() - completionStarted };
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    try {
      parseJsonObject(content);
      health.schema = { status: 'pass' };
    } catch (error) {
      health.schema = { status: 'unsupported', message: '模型可以回复，但未返回 JSON；生成事件时会自动使用兼容模式。' };
    }
    return { ok: health.completion.status === 'pass', health };
  } catch (error) {
    health.completion = { status: 'fail', message: error.message, latencyMs: Date.now() - completionStarted };
    health.schema = { status: 'skipped' };
    return { ok: false, health };
  }
}

export async function fetchModelList({ settings, fetcher = globalThis.fetch, cacheStore = null, force = false }) {
  const api = settings?.api ?? {};
  if (!api.baseUrl) throw new Error('API Base URL missing');
  const cached = cacheStore?.getModels?.(api) ?? null;
  if (cached && !cached.stale && !force) return markCached(cached.models, false);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(api.timeoutMs ?? 5000));
  const url = `${normalizeBaseUrl(api.baseUrl)}/models`;

  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (api.apiKey) {
      headers.Authorization = `Bearer ${api.apiKey}`;
    }

    let response;
    if (api.connectionMode === 'proxy') {
      response = await fetcher('/api/plugins/world-event-director/proxy/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: url,
          method: 'GET',
          headers,
        }),
        signal: controller.signal,
      });
    } else {
      response = await fetcher(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw createModelListError({ api, status: response.status, body: text });
    }

    const data = await response.json();
    const rows = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : data.models);
    if (!Array.isArray(rows)) throw new Error('模型列表响应格式不受支持：缺少 data 或 models 数组');

    const models = rows.map((model) => ({
      id: model.id || model.name,
      name: model.id || model.name,
      owned_by: model.owned_by,
    }));
    cacheStore?.setModels?.(models, api);
    return models;
  } catch (error) {
    if (cached?.models?.length) return markCached(cached.models, true);
    if (error.name === 'AbortError') throw new Error('模型列表请求超时');
    throw explainNetworkError(error, api);
  } finally {
    clearTimeout(timeout);
  }
}

function createModelListError({ api, status, body }) {
  if (api.connectionMode === 'proxy' && status === 404) {
    return new Error('本地代理不可用或目标 API 不支持 /models：请确认 server-plugin 已安装并重启 SillyTavern；也可以手动填写模型名称后点击测试连接。');
  }
  if (status === 404 || status === 405) {
    return new Error('该 API 不支持 /models：请手动填写模型名称后点击测试连接。');
  }
  return new Error(`API HTTP ${status}: ${String(body).slice(0, 160)}`);
}

function explainNetworkError(error, api) {
  if (error?.name === 'AbortError') return error;
  if (api.connectionMode === 'direct' && (error instanceof TypeError || /failed to fetch|networkerror/i.test(error?.message ?? ''))) {
    return new Error('直连失败：手机浏览器可能被 API 的 CORS 策略拦截，或网络无法访问该地址。请改用已安装的本地代理，或使用允许浏览器跨域的 API。');
  }
  if (api.connectionMode === 'proxy' && (error instanceof TypeError || /failed to fetch|networkerror/i.test(error?.message ?? ''))) {
    return new Error('本地代理请求失败：请确认 SillyTavern 正在运行，且 server-plugin 已安装并启用。');
  }
  return error;
}

function fetchWithApi({ fetcher, url, api, method, signal }) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` };
  if (api.connectionMode === 'proxy') {
    return fetcher('/api/plugins/world-event-director/proxy/forward', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: url, method, headers }), signal,
    });
  }
  return fetcher(url, { method, headers, signal });
}

function normalizeBaseUrl(value) {
  return String(value ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)$/i, '');
}

async function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function markCached(models, stale) {
  const result = models.map((model) => ({ ...model }));
  Object.defineProperty(result, 'stale', { value: stale, enumerable: false });
  return result;
}

export async function requestEventCatalog({
  settings, contextSummary, count = 5, existingEvents = [], replaceEventIds = [],
  mode = 'initial', activeEvent = null, eventHistory = [], requestNumber = 1,
  previousError = null, fetcher = globalThis.fetch, logger = console,
  onTiming = () => {},
}) {
  const api = settings?.api ?? {};
  if (!api.apiKey || !api.baseUrl) throw new Error('请先配置事件导演 API');
  const buildMessages = (context) => [
    { role: 'system', content: buildEventCatalogSystemPrompt({ count, mode, hasProgressReview: Boolean(activeEvent) })
      + (previousError ? '\n上轮未达标，本轮只返回剩余缺口，不重复已有事件。' : '') },
    { role: 'user', content: buildEventCatalogUserPrompt({ contextSummary: context, count,
      existingEvents: existingEvents.map(({ id, title, category }) => ({ id, title, category })),
      replaceEventIds, activeEvent, eventHistory }) },
  ];
  const payload = {
    model: api.model, temperature: Number(api.temperature ?? 0.2),
    max_tokens: Math.max(Number(api.maxTokens ?? 800), count * 700), messages: buildMessages(contextSummary),
    ...(requestNumber === 1 ? { response_format: { type: 'json_object' } } : {}),
  };
  logger.info?.('发送事件清单请求', { requestNumber, count });
  const parsed = await performCatalogFetch({ fetcher, api, payload,
    url: `${normalizeBaseUrl(api.baseUrl)}/chat/completions`, timeoutMs: Math.max(1000, Number(api.catalogTimeoutMs ?? 90000)), logger, onTiming, requestNumber });
  const events = Array.isArray(parsed) ? parsed : parsed.events ?? (mode === 'review' ? [] : null);
  if (!Array.isArray(events)) throw new Error('模型未返回事件数组');
  const accepted = [];
  const seen = new Set(existingEvents.map((event) => event.id));
  const rejected = [];
  for (const raw of events) {
    const event = normalizeTemplate(raw);
    const schema = validateTemplate(event);
    const references = validateCatalogReferences(event, contextSummary);
    const quality = validateGeneratedEvent(event);
    if (!schema.valid || !references.valid || !quality.valid || seen.has(event.id)) {
      rejected.push({ id: event.id, errors: [...schema.errors, ...references.errors, ...quality.errors] });
      continue;
    }
    if (accepted.length >= count) break;
    accepted.push({ ...event, occurred: false });
    seen.add(event.id);
  }
  // The coordinator owns the shared four-request budget and submits partial results.
  return { events: accepted, rejected, contextSummary,
    requestAttempts: 1,
    eventProgress: Array.isArray(parsed.eventProgress) ? parsed.eventProgress.filter(isValidProgress) : [] };
}

async function performCatalogFetch({ fetcher, url, api, payload, timeoutMs, logger, onTiming, requestNumber }) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timing = { requestNumber, startedAt, stage: 'waiting_headers', timeoutMs };
  const report = (next) => {
    timing = { ...timing, ...next, elapsedMs: Date.now() - startedAt };
    logger.info?.('事件请求阶段', timing);
    onTiming({ ...timing });
  };
  const timeout = setTimeout(() => {
    report({ stage: 'timeout', timeoutAt: Date.now(), waitingFor: timing.stage });
    controller.abort();
  }, timeoutMs);
  try {
    report({ stage: 'waiting_headers' });
    const response = await performFetch({ fetcher, url, api, payload, signal: controller.signal });
    report({ stage: 'reading_body', headersAt: Date.now(), httpStatus: response.status });
    if (!response.ok) {
      const error = new Error(`事件生成 API HTTP ${Number(response.status)}`);
      error.retryable = ![401, 402, 403, 404, 405, 413].includes(response.status);
      throw error;
    }
    const data = await response.json();
    report({ stage: 'body_complete', bodyCompletedAt: Date.now(),
      inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens,
      reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
      finishReason: data.choices?.[0]?.finish_reason });
    logger.info?.('事件模型响应完成', { elapsedMs: Date.now() - startedAt,
      inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens,
      reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
      finishReason: data.choices?.[0]?.finish_reason });
    const parsed = await readCatalogResponse({ ok: true, json: async () => data });
    report({ stage: 'parsed', parsedAt: Date.now() });
    return parsed;
  } catch (error) {
    const failureKind = error.name === 'AbortError' ? 'timeout'
      : timing.httpStatus >= 400 ? 'http'
        : timing.bodyCompletedAt ? 'response_format'
          : timing.headersAt ? 'response_body' : 'network';
    report({ stage: 'failed', failedAt: Date.now(), failureKind,
      error: failureKind === 'timeout' ? '超过单次等待上限' : error.message });
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`本次事件生成等待超过 ${Math.round(timeoutMs / 1000)} 秒，未收到完整结果`);
      timeoutError.retryable = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readCatalogResponse(response) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  const data = await response.json();
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (message?.refusal || isExplicitRefusalText(content)) throw new Error('catalog_provider_refusal');
  if (!content) throw new Error('API response missing choices[0].message.content');
  return parseJsonObject(content);
}

function isExplicitRefusalText(content) {
  return /^\s*(?:抱歉|我不能|我无法|无法协助|不能协助|I(?:'m| am) sorry\b|I cannot\b|I can't\b|I am unable to\b)/i.test(String(content ?? ''));
}

function isJsonParseError(error) {
  return error?.message === 'API response is not JSON' || error instanceof SyntaxError;
}

function isValidProgress(progress) {
  return Boolean(
    progress &&
    progress.eventId &&
    ['triggered', 'active', 'aftermath', 'resolved', 'failed', 'expired'].includes(progress.status),
  );
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) throw new Error('API response is not JSON');
    return JSON.parse(match[0]);
  }
}
