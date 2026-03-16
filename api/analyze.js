const {
  collectUrlsFromSitemap,
  analyzeDeterministic,
  sampleUrls,
  enrichEntriesWithPageSignals,
  buildCacheKey,
} = require('../lib/sitemap');

function send(res, status, data) {
  res.status(status).setHeader('Access-Control-Allow-Origin', '*').setHeader('Access-Control-Allow-Headers', 'Content-Type').json(data);
}

function extractJsonText(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch {
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try { return JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
    }
    return null;
  }
}

function buildCustomProviderUrl(baseUrl, apiStyle = 'chat') {
  const raw = (baseUrl || '').trim();
  if (!raw) return '';

  const normalized = raw.replace(/\/+$/, '');
  const hasKnownEndpoint = /(\/chat\/completions|\/responses)$/i.test(normalized);
  if (hasKnownEndpoint) return normalized;

  if (apiStyle === 'responses') return `${normalized}/responses`;
  return `${normalized}/chat/completions`;
}

async function callProviderJson(providerConfig, payload, maxOutputTokens = 900) {
  const provider = (providerConfig?.provider || '').toLowerCase();
  const apiKey = providerConfig?.apiKey;
  const model = providerConfig?.model;
  if (!apiKey) throw new Error('Vui lòng nhập API key.');
  if (!model) throw new Error('Vui lòng nhập model.');

  const systemPrompt = 'Bạn là chuyên gia SEO. Chỉ trả JSON hợp lệ theo schema yêu cầu, không markdown.';
  const userPayload = JSON.stringify(payload);

  if (provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_output_tokens: maxOutputTokens,
        text: { format: { type: 'json_object' } },
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          { role: 'user', content: [{ type: 'input_text', text: userPayload }] },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI lỗi ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const txt = data.output_text || data.output?.flatMap((x) => x.content || []).find((c) => c.type === 'output_text')?.text || '';
    const parsed = extractJsonText(txt);
    if (!parsed) throw new Error('Provider trả về không parse được JSON.');
    return parsed;
  }

  if (provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPayload}` }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
    if (!r.ok) throw new Error(`Gemini lỗi ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const txt = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
    const parsed = extractJsonText(txt);
    if (!parsed) throw new Error('Gemini trả về không parse được JSON.');
    return parsed;
  }

  if (provider === 'claude') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPayload }],
      }),
    });
    if (!r.ok) throw new Error(`Claude lỗi ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const txt = data.content?.map((x) => x.text || '').join('\n') || '';
    const parsed = extractJsonText(txt);
    if (!parsed) throw new Error('Claude trả về không parse được JSON.');
    return parsed;
  }

  if (provider === 'grok' || provider === 'openrouter' || provider === 'custom') {
    const isGrok = provider === 'grok';
    const isOpenRouter = provider === 'openrouter';
    const baseUrl =
      provider === 'custom'
        ? providerConfig.baseUrl
        : isGrok
        ? 'https://api.x.ai/v1/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
    if (!baseUrl) throw new Error('Vui lòng nhập Custom base URL.');

    const useResponses = provider === 'custom' && providerConfig.apiStyle === 'responses';
    const url =
      provider === 'custom'
        ? buildCustomProviderUrl(baseUrl, providerConfig.apiStyle)
        : baseUrl;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

    const body = useResponses
      ? {
          model,
          text: { format: { type: 'json_object' } },
          input: [
            { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
            { role: 'user', content: [{ type: 'input_text', text: userPayload }] },
          ],
        }
      : {
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPayload },
          ],
        };

    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${provider} lỗi ${r.status}: ${await r.text()}`);
    const data = await r.json();

    const txt = useResponses
      ? data.output_text || data.output?.flatMap((x) => x.content || []).find((c) => c.type === 'output_text')?.text || ''
      : data.choices?.[0]?.message?.content || '';

    const parsed = extractJsonText(txt);
    if (!parsed) throw new Error(`${provider} trả về không parse được JSON.`);
    return parsed;
  }

  throw new Error('Provider chưa được hỗ trợ.');
}

async function callAIPipeline(providerConfig, deterministic, sampledEntries, mode) {
  const payload = {
    task: 'seo_sitemap_synthesis',
    mode,
    deterministic: {
      totalUrls: deterministic.totalUrls,
      score: deterministic.score,
      issueBreakdown: deterministic.issueBreakdown,
      categoryBreakdown: deterministic.categoryBreakdown,
      freshnessBreakdown: deterministic.freshnessBreakdown,
      onpageSummary: deterministic.onpageSummary,
    },
    sampledEntries: sampledEntries.map((x) => ({
      url: x.loc,
      priority: x.priority,
      changefreq: x.changefreq,
      sourceSitemap: x.sourceSitemap,
      pageTitle: x.pageSignals?.title || null,
    })),
    schema: {
      summary: 'string',
      confidence: 'high|medium|low',
      issues: ['string'],
      recommendations: [{ action: 'string', impact: 'high|medium|low', effort: 'high|medium|low' }],
      tokenStrategy: 'string',
    },
  };

  const out = await callProviderJson(providerConfig, payload, 900);
  return {
    summary: out.summary || 'Đã phân tích xong.',
    confidence: out.confidence || 'medium',
    issues: Array.isArray(out.issues) ? out.issues : [],
    recommendations: Array.isArray(out.recommendations) ? out.recommendations : [],
    tokenStrategy: out.tokenStrategy || 'hybrid-deterministic-plus-ai',
    stages: {},
  };
}

async function validateProviderConfig(providerConfig) {
  const pingPayload = {
    task: 'provider_healthcheck',
    instruction: 'Trả JSON: {\"ok\": true}',
    schema: { ok: true },
  };
  try {
    await callProviderJson(providerConfig, pingPayload, 120);
  } catch (e) {
    throw new Error(`Không thể kết nối provider hoặc thông tin API key/model/base URL không hợp lệ: ${e.message}`);
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  try {
    const sitemapUrl = req.body?.sitemapUrl;
    const mode = req.body?.mode || 'balanced';
    const customCategoryUrls = Array.isArray(req.body?.customCategoryUrls) ? req.body.customCategoryUrls : [];
    const providerConfig = req.body?.providerConfig || {};

    if (!providerConfig.apiKey) return send(res, 400, { error: 'Vui lòng nhập API key.' });
    if (!providerConfig.model) return send(res, 400, { error: 'Vui lòng nhập model.' });
    if (!sitemapUrl) return send(res, 400, { error: 'Missing sitemapUrl' });

    await validateProviderConfig(providerConfig);

    const collected = await collectUrlsFromSitemap(sitemapUrl, { maxUrls: 50000, maxSitemaps: 40 });
    if (!collected.urls.length) return send(res, 422, { error: 'Không tìm thấy URL trong sitemap.' });

    const enrichedEntries = await enrichEntriesWithPageSignals(collected.entries, { mode, maxFetch: collected.entries.length, concurrency: 6 });
    const deterministic = analyzeDeterministic(enrichedEntries, { customCategoryUrls });
    const sampledEntries = sampleUrls(enrichedEntries, { mode, customCategoryUrls });
    const ai = await callAIPipeline(providerConfig, deterministic, sampledEntries, mode);

    const payload = {
      deterministic,
      ai,
      sampledCount: sampledEntries.length,
      crawledSitemaps: collected.crawledSitemaps,
      truncated: collected.truncated,
      mode,
      cached: false,
      generatedAt: new Date().toISOString(),
    };
    return send(res, 200, payload);
  } catch (error) {
    const msg = error.message || 'Unexpected error';
    const status = /api key|model|base url|không parse|lỗi/i.test(msg) ? 400 : 500;
    return send(res, status, { error: msg });
  }
};
