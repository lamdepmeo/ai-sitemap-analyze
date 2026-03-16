const providerSelect = document.getElementById('providerSelect');
const apiKeyInput = document.getElementById('apiKey');
const modelNameInput = document.getElementById('modelName');
const customBaseUrlInput = document.getElementById('customBaseUrl');
const customApiStyleSelect = document.getElementById('customApiStyle');
const customProviderFields = document.getElementById('customProviderFields');

const analyzeBtn = document.getElementById('analyzeBtn');
const sitemapUrlInput = document.getElementById('sitemapUrl');
const modeSelect = document.getElementById('modeSelect');
const customCategoriesInput = document.getElementById('customCategories');
const statusBox = document.getElementById('status');
const dashboard = document.getElementById('dashboard');

const progressWrap = document.getElementById('progressWrap');
const progressPercent = document.getElementById('progressPercent');
const progressBarFill = document.getElementById('progressBarFill');

const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportPdfBtn = document.getElementById('exportPdfBtn');

const totalUrlsEl = document.getElementById('totalUrls');
const seoScoreEl = document.getElementById('seoScore');
const deepUrlsEl = document.getElementById('deepUrls');
const paramUrlsEl = document.getElementById('paramUrls');
const freshNewPctEl = document.getElementById('freshNewPct');
const stalePctEl = document.getElementById('stalePct');

const issueBreakdownList = document.getElementById('issueBreakdownList');
const recommendationList = document.getElementById('recommendationList');
const aiStageList = document.getElementById('aiStageList');
const onpageList = document.getElementById('onpageList');
const categoryTableBody = document.getElementById('categoryTableBody');
const diagnosticTableBody = document.getElementById('diagnosticTableBody');
const categoryChart = document.getElementById('categoryChart');
const issueChart = document.getElementById('issueChart');
const freshnessChart = document.getElementById('freshnessChart');
const onpageChart = document.getElementById('onpageChart');

let latestReport = null;
let progressTimer = null;

function resolveApiEndpoint(path = '/api/analyze') {
  if (window.location.origin.includes('localhost:4173')) return `http://localhost:8787${path}`;
  return path;
}

const API_ANALYZE = resolveApiEndpoint('/api/analyze');

function setStatus(message, type = 'info') {
  statusBox.className = `status ${type}`;
  statusBox.textContent = message;
  statusBox.classList.remove('hidden');
}

function renderList(element, items, emptyText) {
  element.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.textContent = emptyText;
    element.appendChild(li);
    return;
  }
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    element.appendChild(li);
  });
}

function renderTable(bodyEl, rows, mapper) {
  bodyEl.innerHTML = '';
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    mapper(row).forEach((v) => tr.appendChild(v));
    bodyEl.appendChild(tr);
  });
}

function makeCell(text, title = '') {
  const td = document.createElement('td');
  td.textContent = String(text);
  if (title) {
    td.classList.add('hover-detail');
    td.title = title;
  }
  return td;
}

function drawBarChart(canvas, data, color = '#38bdf8') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!data?.length) {
    ctx.fillStyle = '#a8bbde';
    ctx.fillText('Không có dữ liệu', 10, 20);
    return;
  }
  const top = data.slice(0, 8);
  const max = Math.max(...top.map((x) => x.value), 1);
  const barH = Math.floor((h - 30) / top.length);
  top.forEach((item, i) => {
    const y = 10 + i * barH;
    const bw = Math.max(2, Math.floor((item.value / max) * (w - 200)));
    ctx.fillStyle = color;
    ctx.fillRect(140, y, bw, Math.max(8, barH - 6));
    ctx.fillStyle = '#dbeafe';
    ctx.font = '12px sans-serif';
    ctx.fillText(item.label.slice(0, 22), 8, y + 14);
    ctx.fillText(String(item.value), 145 + bw, y + 14);
  });
}

function renderOnpageSummary(onpage = {}) {
  renderList(
    onpageList,
    [
      `Số trang đã bóc tách HTML: ${onpage.pagesAnalyzed || 0}`,
      `Trang internal link yếu: ${onpage.weakInternalLinks || 0} (${onpage.weakInternalLinksRate || '0.0'}%)`,
      `Trang anchor text chung chung: ${onpage.poorAnchors || 0} (${onpage.poorAnchorsRate || '0.0'}%)`,
      `Trang thiếu media: ${onpage.missingMedia || 0} (${onpage.missingMediaRate || '0.0'}%)`,
      `Trang có ảnh thiếu alt: ${onpage.missingAlt || 0} (${onpage.missingAltRate || '0.0'}%)`,
    ],
    'Chưa đủ dữ liệu onpage.'
  );
}

function buildDiagnosticTooltip(d) {
  const parts = [];
  const anchors = d.issueDetails?.poorAnchorExamples || [];
  const imgs = d.issueDetails?.missingAltImages || [];
  if (anchors.length) {
    parts.push('Anchor cần tối ưu:');
    anchors.slice(0, 6).forEach((a) => parts.push(`- "${a.text}" -> ${a.href}`));
  }
  if (imgs.length) {
    parts.push('Ảnh thiếu alt:');
    imgs.slice(0, 6).forEach((src) => parts.push(`- ${src}`));
  }
  if ((d.optimizationTips || []).length) {
    parts.push('Gợi ý tối ưu:');
    d.optimizationTips.slice(0, 4).forEach((t) => parts.push(`- ${t}`));
  }
  return parts.join('\n');
}

function renderAiRecommendations(report) {
  const aiRecs = (report.ai?.recommendations || []).map((r) =>
    typeof r === 'string' ? r : `${r.action} (tác động: ${r.impact}, công sức: ${r.effort})`
  );
  const internalOp = (report.deterministic?.internalLinkOpportunities || [])
    .slice(0, 8)
    .map((x) => `${x.url}\n- ${x.suggestions.join('\n- ')}`);
  return [...aiRecs, ...internalOp];
}

function downloadText(filename, content, contentType) {
  const blob = new Blob([content], { type: contentType });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
}

function toCsv(report) {
  const lines = ['url,category,parentCategory,priority,changefreq,issues,optimizationTips'];
  (report.deterministic?.urlDiagnostics || []).slice(0, 500).forEach((d) => {
    const row = [
      d.url,
      d.category,
      d.parentCategory || '',
      d.priority ?? '',
      d.changefreq ?? '',
      (d.issues || []).join(' | '),
      (d.optimizationTips || []).join(' | '),
    ].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',');
    lines.push(row);
  });
  return lines.join('\n');
}

function toPdfHtml(report) {
  const base = report.deterministic || {};
  const recs = renderAiRecommendations(report).slice(0, 40).map((x) => `<li>${x.replace(/</g, '&lt;')}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sitemap Report</title><style>body{font-family:Arial,sans-serif;padding:24px}h1{margin:0 0 12px}li{margin:6px 0}</style></head><body><h1>Sitemap Analysis Report</h1><p>Total URLs: ${base.totalUrls || 0}</p><p>SEO Score: ${base.score || 0}</p><h2>Khuyến nghị</h2><ul>${recs}</ul></body></html>`;
}

function getProviderConfig() {
  const provider = providerSelect.value;
  const apiKey = apiKeyInput.value.trim();
  const model = modelNameInput.value.trim();
  const config = { provider, apiKey, model };
  if (provider === 'custom') {
    config.baseUrl = customBaseUrlInput.value.trim();
    config.apiStyle = customApiStyleSelect.value;
  }
  return config;
}

function startProgress() {
  progressWrap.classList.remove('hidden');
  let v = 0;
  progressPercent.textContent = '0%';
  progressBarFill.style.width = '0%';
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    v = Math.min(92, v + Math.random() * 8);
    progressPercent.textContent = `${Math.round(v)}%`;
    progressBarFill.style.width = `${v}%`;
  }, 350);
}

function stopProgress(done = true) {
  clearInterval(progressTimer);
  if (done) {
    progressPercent.textContent = '100%';
    progressBarFill.style.width = '100%';
    setTimeout(() => progressWrap.classList.add('hidden'), 600);
  } else {
    progressWrap.classList.add('hidden');
  }
}

async function analyzeSitemap(sitemapUrl, mode, customCategoryUrls, providerConfig) {
  const res = await fetch(API_ANALYZE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sitemapUrl, mode, customCategoryUrls, providerConfig }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API error ${res.status}`);
  return data;
}

providerSelect.addEventListener('change', () => {
  customProviderFields.classList.toggle('hidden', providerSelect.value !== 'custom');
});

analyzeBtn.addEventListener('click', async () => {
  const sitemapUrl = sitemapUrlInput.value.trim();
  const mode = modeSelect.value;
  const customCategoryUrls = (customCategoriesInput?.value || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const providerConfig = getProviderConfig();

  if (!providerConfig.apiKey) return setStatus('Vui lòng nhập API key trước khi phân tích.', 'warning');
  if (!providerConfig.model) return setStatus('Vui lòng nhập tên model.', 'warning');
  if (providerConfig.provider === 'custom' && !providerConfig.baseUrl) return setStatus('Vui lòng nhập Custom base URL.', 'warning');
  if (!sitemapUrl) return setStatus('Vui lòng nhập sitemap URL.', 'warning');

  try {
    analyzeBtn.disabled = true;
    setStatus(`Đang phân tích với ${providerConfig.provider} (${mode})...`, 'info');
    startProgress();

    const report = await analyzeSitemap(sitemapUrl, mode, customCategoryUrls, providerConfig);
    latestReport = report;

    const base = report.deterministic || {};
    totalUrlsEl.textContent = base.totalUrls || 0;
    seoScoreEl.textContent = `${base.score || 0}/100`;
    deepUrlsEl.textContent = base.deepUrls || 0;
    paramUrlsEl.textContent = base.paramUrls || 0;

    const fresh = (base.freshnessBreakdown || []).find((x) => x.label.includes('Nội dung mới'));
    const stale = (base.freshnessBreakdown || []).find((x) => x.label.includes('Cần cập nhật'));
    freshNewPctEl.textContent = `${fresh?.ratio || '0.0'}%`;
    stalePctEl.textContent = `${stale?.ratio || '0.0'}%`;

    drawBarChart(categoryChart, base.chartData?.categories || [], '#22c55e');
    drawBarChart(issueChart, base.chartData?.issues || [], '#f59e0b');
    drawBarChart(freshnessChart, base.chartData?.freshness || [], '#a78bfa');
    drawBarChart(onpageChart, base.chartData?.onpage || [], '#f97316');

    renderList(issueBreakdownList, (base.issueBreakdown || []).map((x) => `${x.name}: ${x.value} (${x.severity})`), 'Không có issue.');
    renderList(aiStageList, (report.ai?.issues || []).slice(0, 12), 'Chưa có insight AI.');
    renderList(recommendationList, renderAiRecommendations(report), 'Chưa có gợi ý.');
    renderOnpageSummary(base.onpageSummary || {});

    renderTable(categoryTableBody, base.categoryBreakdown || [], (r) => [
      makeCell(r.category), makeCell(r.count), makeCell(`${r.ratio}%`), makeCell(r.avgDepth), makeCell(`${r.paramRate}%`), makeCell(r.avgPriority), makeCell(r.topChangefreq),
    ]);

    renderTable(
      diagnosticTableBody,
      (base.urlDiagnostics || []).filter((d) => (d.issues || []).length).slice(0, 500),
      (d) => [makeCell(d.url), makeCell(d.category), makeCell(d.parentCategory || '-'), makeCell(d.priority ?? 'n/a'), makeCell(d.changefreq ?? 'n/a'), makeCell(d.issues.join('; '), buildDiagnosticTooltip(d))]
    );

    dashboard.classList.remove('hidden');
    setStatus('Phân tích hoàn tất.', 'success');
    stopProgress(true);
  } catch (error) {
    stopProgress(false);
    dashboard.classList.add('hidden');
    setStatus(error.message || 'Đã có lỗi xảy ra.', 'error');
  } finally {
    analyzeBtn.disabled = false;
  }
});

exportJsonBtn.addEventListener('click', () => {
  if (!latestReport) return setStatus('Chưa có report để export.', 'warning');
  downloadText(`sitemap-report-${Date.now()}.json`, JSON.stringify(latestReport, null, 2), 'application/json');
});

exportCsvBtn.addEventListener('click', () => {
  if (!latestReport) return setStatus('Chưa có report để export.', 'warning');
  downloadText(`sitemap-report-${Date.now()}.csv`, toCsv(latestReport), 'text/csv;charset=utf-8');
});

exportPdfBtn.addEventListener('click', () => {
  if (!latestReport) return setStatus('Chưa có report để export.', 'warning');
  const w = window.open('', '_blank');
  if (!w) return setStatus('Trình duyệt chặn popup export PDF.', 'warning');
  w.document.write(toPdfHtml(latestReport));
  w.document.close();
  w.focus();
  w.print();
});
