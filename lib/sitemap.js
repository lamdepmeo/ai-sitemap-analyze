const crypto = require('crypto');

function extractTagValue(block, tagName) {
  const regex = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, 'i');
  const match = block.match(regex);
  return match?.[1]?.trim() || '';
}

function isSitemapIndex(xmlText) {
  return /<sitemapindex[\s>]/i.test(xmlText);
}

function parseChildSitemapLocs(xmlText) {
  const blockPattern = /<sitemap>[\s\S]*?<\/sitemap>/gi;
  const out = [];
  let match;
  while ((match = blockPattern.exec(xmlText)) !== null) {
    const block = match[0];
    const loc = extractTagValue(block, 'loc');
    const lastmod = extractTagValue(block, 'lastmod');
    if (loc) out.push({ loc, lastmod });
  }
  return out;
}

function parseUrlEntries(xmlText, sourceSitemap) {
  const blockPattern = /<url>[\s\S]*?<\/url>/gi;
  const out = [];
  let match;
  while ((match = blockPattern.exec(xmlText)) !== null) {
    const block = match[0];
    const loc = extractTagValue(block, 'loc');
    if (!loc) continue;

    const changefreq = extractTagValue(block, 'changefreq').toLowerCase();
    const priorityRaw = extractTagValue(block, 'priority');
    const priority = Number.isFinite(Number(priorityRaw)) ? Number(priorityRaw) : null;
    const lastmod = extractTagValue(block, 'lastmod');

    out.push({
      loc,
      changefreq: changefreq || null,
      priority,
      lastmod: lastmod || null,
      sourceSitemap,
    });
  }
  return out;
}

async function fetchSitemap(url) {
  const first = await fetch(url);
  if (first.ok) return first.text();

  const proxied = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const second = await fetch(proxied);
  if (!second.ok) throw new Error(`Cannot fetch sitemap: ${first.status}/${second.status}`);
  return second.text();
}

async function collectUrlsFromSitemap(startUrl, options = {}) {
  const maxUrls = options.maxUrls || 50000;
  const maxSitemaps = options.maxSitemaps || 40;

  const queue = [{ loc: startUrl }];
  const visitedSitemaps = new Set();
  const entries = [];

  while (queue.length && entries.length < maxUrls && visitedSitemaps.size < maxSitemaps) {
    const current = queue.shift();
    if (visitedSitemaps.has(current.loc)) continue;
    visitedSitemaps.add(current.loc);

    const xml = await fetchSitemap(current.loc);

    if (isSitemapIndex(xml)) {
      const children = parseChildSitemapLocs(xml);
      for (const child of children) {
        if (!visitedSitemaps.has(child.loc)) queue.push({ loc: child.loc });
        if (queue.length + visitedSitemaps.size >= maxSitemaps) break;
      }
      continue;
    }

    const foundEntries = parseUrlEntries(xml, current.loc);
    for (const entry of foundEntries) {
      entries.push(entry);
      if (entries.length >= maxUrls) break;
    }
  }

  return {
    entries,
    urls: entries.map((x) => x.loc),
    crawledSitemaps: visitedSitemaps.size,
    truncated: entries.length >= maxUrls,
  };
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin}${path}`;
  } catch {
    return url;
  }
}

function sourceHint(sourceSitemap) {
  const s = (sourceSitemap || '').toLowerCase();
  if (/product|san-pham|sp-/.test(s)) return 'product';
  if (/post|blog|news|tin-tuc|bai-viet/.test(s)) return 'post';
  if (/category|danh-muc|catalog|collection/.test(s)) return 'category';
  if (/page|trang/.test(s)) return 'page';
  return 'unknown';
}

function isStaticLike(path) {
  return /\/(lien-he|contact|about|gioi-thieu|chinh-sach|privacy|terms|faq)\/?$/.test(path);
}

function inferCategorySeeds(entries, customCategoryUrls = []) {
  const custom = (customCategoryUrls || []).map(normalizeUrl).filter(Boolean);
  if (custom.length) return custom;

  const candidates = [];
  for (const e of entries) {
    try {
      const u = new URL(e.loc);
      const path = u.pathname.toLowerCase();
      const depth = path.split('/').filter(Boolean).length;
      if (depth !== 1 || isStaticLike(path) || path === '/') continue;

      const hint = sourceHint(e.sourceSitemap);
      const priority = e.priority ?? 0;
      const freq = e.changefreq || '';
      const score =
        (hint === 'category' ? 5 : 0) +
        (priority >= 0.7 ? 3 : priority >= 0.5 ? 2 : 0) +
        (['daily', 'weekly'].includes(freq) ? 2 : 0);

      if (score >= 3) candidates.push({ url: normalizeUrl(e.loc), score });
    } catch {
      continue;
    }
  }

  const map = new Map();
  candidates.forEach((c) => map.set(c.url, Math.max(c.score, map.get(c.url) || 0)));
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map((x) => x[0]);
}

function findParentCategory(url, categorySeeds) {
  const normalized = normalizeUrl(url);
  let best = null;
  for (const seed of categorySeeds) {
    if (normalized === seed) continue;
    if (normalized.startsWith(seed + '/')) {
      if (!best || seed.length > best.length) best = seed;
    }
  }
  return best;
}

function pickDateIso(entry) {
  const cands = [entry.lastmod, entry.pageSignals?.dateModified, entry.pageSignals?.datePublished].filter(Boolean);
  for (const c of cands) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function classifyEntry(entry, context = {}) {
  const categorySeeds = context.categorySeeds || [];

  let parsed;
  try {
    parsed = new URL(entry.loc);
  } catch {
    return { type: 'Khác', parentCategory: null };
  }

  const path = parsed.pathname.toLowerCase();
  const segments = path.split('/').filter(Boolean);
  const depth = segments.length;
  const hint = sourceHint(entry.sourceSitemap);
  const normalized = normalizeUrl(entry.loc);

  if (path === '/' || !segments.length) return { type: 'Trang chủ', parentCategory: null };
  if (isStaticLike(path) || hint === 'page') return { type: 'Page tĩnh', parentCategory: null };

  if (categorySeeds.includes(normalized)) return { type: 'Danh mục', parentCategory: normalized };

  const breadcrumbHits = (entry.pageSignals?.breadcrumbUrls || []).map(normalizeUrl).filter((u) => categorySeeds.includes(u));
  const breadcrumbParent = breadcrumbHits.sort((a, b) => b.length - a.length)[0] || null;
  if (breadcrumbParent) {
    const isProduct = hint === 'product' || /\/(san-pham|product|shop|cua-hang|sp|p)\//.test(path);
    return { type: isProduct ? 'Sản phẩm chi tiết' : 'Bài viết chi tiết', parentCategory: breadcrumbParent };
  }

  const parentCategory = findParentCategory(entry.loc, categorySeeds);
  if (parentCategory) {
    const isProduct = hint === 'product' || /\/(san-pham|product|shop|cua-hang|sp|p)\//.test(path);
    return { type: isProduct ? 'Sản phẩm chi tiết' : 'Bài viết chi tiết', parentCategory };
  }

  if (hint === 'category' || /\/(danh-muc|category|catalog|collections?)\//.test(path)) return { type: 'Danh mục', parentCategory: normalized };
  if (hint === 'post' || /\/(tin-tuc|blog|news|bai-viet|kien-thuc)\//.test(path)) return { type: 'Bài viết chi tiết', parentCategory: null };
  if (hint === 'product' || /\/(san-pham|product|shop|cua-hang|sp|p)\//.test(path)) {
    return { type: depth >= 2 ? 'Sản phẩm chi tiết' : 'Trang sản phẩm', parentCategory: null };
  }

  if ((entry.priority ?? 0) >= 0.7 && depth === 1) return { type: 'Danh mục', parentCategory: normalized };
  if ((entry.priority ?? 0) <= 0.4 && depth >= 2) return { type: 'Bài viết chi tiết', parentCategory: null };

  return { type: 'Khác', parentCategory: null };
}

function detectTemplate(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return 'home';
  if (parts.length === 1) return 'single-level';
  if (parts.length === 2) return 'two-level';
  if (parts.length <= 4) return 'deep-3-4';
  return 'very-deep';
}

function freshnessBucket(updatedIso) {
  if (!updatedIso) return 'Không rõ';
  const updated = new Date(updatedIso);
  if (Number.isNaN(updated.getTime())) return 'Không rõ';
  const days = (Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 30) return 'Nội dung mới (<=30 ngày)';
  if (days > 365) return 'Cần cập nhật (>12 tháng)';
  return 'Nội dung hiện hành';
}

function analyzeDeterministic(input, options = {}) {
  const entriesInput = (input || []).map((x) => (typeof x === 'string' ? { loc: x } : x));
  const categorySeeds = inferCategorySeeds(entriesInput, options.customCategoryUrls || []);

  const seen = new Set();
  const hostMap = new Map();
  const categoryMap = new Map();
  const templateMap = new Map();
  const issueBuckets = new Map();
  const freshnessMap = new Map([
    ['Nội dung mới (<=30 ngày)', 0],
    ['Nội dung hiện hành', 0],
    ['Cần cập nhật (>12 tháng)', 0],
    ['Không rõ', 0],
  ]);

  const diagnostics = [];
  let duplicateUrls = 0;
  let deepUrls = 0;
  let paramUrls = 0;
  let longSlugUrls = 0;
  let uppercaseUrls = 0;
  let httpUrls = 0;
  let missingPriority = 0;
  let missingChangefreq = 0;

  const onpageCounters = {
    weakInternalLinks: 0,
    poorAnchors: 0,
    missingMedia: 0,
    missingAlt: 0,
    pagesAnalyzed: 0,
  };

  for (const entry of entriesInput) {
    if (seen.has(entry.loc)) {
      duplicateUrls += 1;
      continue;
    }
    seen.add(entry.loc);

    let parsed;
    try {
      parsed = new URL(entry.loc);
    } catch {
      continue;
    }

    const path = parsed.pathname || '/';
    const segments = path.split('/').filter(Boolean);
    const depth = segments.length;
    const hasParam = parsed.search.length > 0;
    const template = detectTemplate(path);
    const classified = classifyEntry(entry, { categorySeeds });

    const issues = [];
    if (depth > 3) { deepUrls += 1; issues.push('URL quá sâu (>3)'); }
    if (hasParam) { paramUrls += 1; issues.push('URL có query params'); }
    if (segments.some((s) => s.length > 80)) { longSlugUrls += 1; issues.push('Slug quá dài (>80)'); }
    if (/[A-Z]/.test(path)) { uppercaseUrls += 1; issues.push('URL chứa ký tự hoa'); }
    if (parsed.protocol === 'http:') { httpUrls += 1; issues.push('Dùng HTTP thay vì HTTPS'); }
    if (entry.priority == null) { missingPriority += 1; issues.push('Thiếu priority'); }
    if (!entry.changefreq) { missingChangefreq += 1; issues.push('Thiếu changefreq'); }

    const signals = entry.pageSignals;
    if (signals) {
      onpageCounters.pagesAnalyzed += 1;
      if ((signals.internalLinkCount || 0) < 3) {
        onpageCounters.weakInternalLinks += 1;
        issues.push('Internal link nội bộ ít (<3)');
      }

      const badAnchorRatio = (signals.internalLinkCount || 0) > 0 ? (signals.poorAnchorCount || 0) / signals.internalLinkCount : 0;
      if ((signals.poorAnchorCount || 0) >= 3 && badAnchorRatio >= 0.4) {
        onpageCounters.poorAnchors += 1;
        issues.push('Anchor text chung chung, chưa tối ưu');
      }

      if ((signals.imageCount || 0) === 0) {
        onpageCounters.missingMedia += 1;
        issues.push('Thiếu hình ảnh minh hoạ');
      }

      if ((signals.imageMissingAltCount || 0) > 0) {
        onpageCounters.missingAlt += 1;
        issues.push('Có ảnh thiếu alt text');
      }

    }

    hostMap.set(parsed.host, (hostMap.get(parsed.host) || 0) + 1);
    templateMap.set(template, (templateMap.get(template) || 0) + 1);

    if (!categoryMap.has(classified.type)) {
      categoryMap.set(classified.type, { count: 0, depthSum: 0, paramCount: 0, prioritySum: 0, priorityCount: 0, changefreqMap: new Map() });
    }
    const cat = categoryMap.get(classified.type);
    cat.count += 1;
    cat.depthSum += depth;
    if (hasParam) cat.paramCount += 1;
    if (typeof entry.priority === 'number') { cat.prioritySum += entry.priority; cat.priorityCount += 1; }
    if (entry.changefreq) cat.changefreqMap.set(entry.changefreq, (cat.changefreqMap.get(entry.changefreq) || 0) + 1);

    issues.forEach((i) => issueBuckets.set(i, (issueBuckets.get(i) || 0) + 1));

    const updatedIso = pickDateIso(entry);
    const freshness = freshnessBucket(updatedIso);
    freshnessMap.set(freshness, (freshnessMap.get(freshness) || 0) + 1);

    const issueDetails = {};
    const optimizationTips = [];

    if (signals?.poorAnchorExamples?.length) {
      issueDetails.poorAnchorExamples = signals.poorAnchorExamples;
      const first = signals.poorAnchorExamples[0];
      const suggested = suggestAnchorsFromUrl(first.href).join(', ');
      optimizationTips.push(`Thay anchor "${first.text}" bằng cụm mô tả rõ ý định tìm kiếm. Gợi ý: ${suggested}.`);
    }
    if (signals?.missingAltImages?.length) {
      issueDetails.missingAltImages = signals.missingAltImages;
      const firstImg = signals.missingAltImages[0];
      optimizationTips.push(`Bổ sung alt mô tả ngữ cảnh cho ảnh ${firstImg}. Ví dụ: mô tả lợi ích/chủ đề chính của bài.`);
    }
    if ((signals?.internalLinkCount || 0) < 3) {
      optimizationTips.push('Thêm 3-5 internal link tới bài liên quan cùng chuyên mục và 1 link về trang danh mục chính.');
    }
    if (classified.parentCategory) {
      optimizationTips.push(`Ưu tiên thêm liên kết điều hướng về chuyên mục: ${classified.parentCategory}.`);
    }

    diagnostics.push({
      url: entry.loc,
      category: classified.type,
      parentCategory: classified.parentCategory,
      template,
      depth,
      priority: entry.priority,
      changefreq: entry.changefreq,
      sourceSitemap: entry.sourceSitemap || '',
      updatedAt: updatedIso,
      freshness,
      pageTitle: entry.pageSignals?.title || null,
      issues,
      issueDetails,
      optimizationTips,
    });
  }

  const totalUrls = seen.size;
  const score = Math.max(0, 100 - duplicateUrls * 3 - Math.ceil(deepUrls * 0.45) - Math.ceil(paramUrls * 1.1) - longSlugUrls * 2 - httpUrls * 4);

  const categoryBreakdown = [...categoryMap.entries()].map(([category, v]) => ({
    category,
    count: v.count,
    ratio: totalUrls ? ((v.count / totalUrls) * 100).toFixed(1) : '0.0',
    avgDepth: v.count ? (v.depthSum / v.count).toFixed(2) : '0.00',
    paramRate: v.count ? ((v.paramCount / v.count) * 100).toFixed(1) : '0.0',
    avgPriority: v.priorityCount ? (v.prioritySum / v.priorityCount).toFixed(2) : 'n/a',
    topChangefreq: [...v.changefreqMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'n/a',
  })).sort((a, b) => b.count - a.count);

  const templateBreakdown = [...templateMap.entries()].map(([template, count]) => ({ template, count, ratio: totalUrls ? ((count / totalUrls) * 100).toFixed(1) : '0.0' })).sort((a, b) => b.count - a.count);

  const issueBreakdown = [...issueBuckets.entries()].map(([name, value]) => ({ name, value, severity: value > totalUrls * 0.25 ? 'high' : value > 0 ? 'medium' : 'low' })).sort((a, b) => b.value - a.value);

  const freshnessBreakdown = [...freshnessMap.entries()].map(([label, value]) => ({ label, value, ratio: totalUrls ? ((value / totalUrls) * 100).toFixed(1) : '0.0' }));

  const analyzedPages = onpageCounters.pagesAnalyzed || 1;
  const onpageSummary = {
    pagesAnalyzed: onpageCounters.pagesAnalyzed,
    weakInternalLinks: onpageCounters.weakInternalLinks,
    poorAnchors: onpageCounters.poorAnchors,
    missingMedia: onpageCounters.missingMedia,
    missingAlt: onpageCounters.missingAlt,
    weakInternalLinksRate: ((onpageCounters.weakInternalLinks / analyzedPages) * 100).toFixed(1),
    poorAnchorsRate: ((onpageCounters.poorAnchors / analyzedPages) * 100).toFixed(1),
    missingMediaRate: ((onpageCounters.missingMedia / analyzedPages) * 100).toFixed(1),
    missingAltRate: ((onpageCounters.missingAlt / analyzedPages) * 100).toFixed(1),
  };


  diagnostics.forEach((d) => {
    if (!d.parentCategory) return;
    const related = selectRelatedUrls(d, diagnostics);
    if (!related.length) return;

    const suggestedLinks = related.map((target) => ({
      target,
      anchors: suggestAnchorsFromUrl(target),
    }));

    d.relatedLinkSuggestions = suggestedLinks;
    if (d.issues.includes('Internal link nội bộ ít (<3)')) {
      suggestedLinks.slice(0, 2).forEach((x) => {
        d.optimizationTips.push(`Nên thêm link nội bộ tới ${x.target} với anchor gợi ý: ${x.anchors[0]}.`);
      });
    }
  });

  return {
    totalUrls,
    duplicateUrls,
    deepUrls,
    paramUrls,
    longSlugUrls,
    uppercaseUrls,
    httpUrls,
    missingPriority,
    missingChangefreq,
    score,
    topDirectories: categoryBreakdown.map((x) => [x.category, x.count]).slice(0, 20),
    topHosts: [...hostMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    categoryBreakdown,
    templateBreakdown,
    issueBreakdown,
    freshnessBreakdown,
    onpageSummary,
    chartData: {
      categories: categoryBreakdown.map((x) => ({ label: x.category, value: x.count })),
      issues: issueBreakdown.map((x) => ({ label: x.name, value: x.value })),
      freshness: freshnessBreakdown.map((x) => ({ label: x.label, value: x.value })),
      onpage: [
        { label: 'Internal link yếu', value: onpageCounters.weakInternalLinks },
        { label: 'Anchor chưa tốt', value: onpageCounters.poorAnchors },
        { label: 'Thiếu media', value: onpageCounters.missingMedia },
        { label: 'Thiếu alt ảnh', value: onpageCounters.missingAlt },
      ],
    },
    categorySeeds,
    urlDiagnostics: diagnostics,
    topDeepUrls: diagnostics.filter((d) => d.depth > 3).sort((a, b) => b.depth - a.depth).slice(0, 15),
    topParamUrls: diagnostics.filter((d) => d.issues.includes('URL có query params')).slice(0, 15),
    topLongestUrls: diagnostics.map((d) => ({ ...d, pathLen: new URL(d.url).pathname.length })).sort((a, b) => b.pathLen - a.pathLen).slice(0, 15),
    internalLinkOpportunities: diagnostics
      .filter((d) => d.parentCategory && d.issues.includes('Internal link nội bộ ít (<3)'))
      .slice(0, 60)
      .map((d) => ({
        url: d.url,
        parentCategory: d.parentCategory,
        suggestions: [
          `Thêm link từ ${d.url} về ${d.parentCategory} với anchor chứa từ khóa chuyên mục.`,
          ...(d.relatedLinkSuggestions || []).slice(0, 2).map((x) => `Thêm link tới ${x.target} với anchor: ${x.anchors[0]}`),
        ],
      })),
  };
}

function getSampleSize(totalUrls, mode = 'balanced') {
  if (mode === 'quick') return Math.min(100, Math.max(50, Math.ceil(totalUrls * 0.003)));
  if (mode === 'deep') return Math.min(300, Math.max(150, Math.ceil(totalUrls * 0.01)));
  return Math.min(200, Math.max(90, Math.ceil(totalUrls * 0.006)));
}

function sampleUrls(input, options = {}) {
  const mode = options.mode || 'balanced';
  const entries = (input || []).map((x) => (typeof x === 'string' ? { loc: x } : x));
  const categorySeeds = inferCategorySeeds(entries, options.customCategoryUrls || []);

  const uniqueMap = new Map();
  for (const e of entries) if (!uniqueMap.has(e.loc)) uniqueMap.set(e.loc, e);
  const unique = [...uniqueMap.values()];

  const maxSample = getSampleSize(unique.length, mode);
  if (unique.length <= maxSample) return unique;

  const buckets = new Map();
  for (const e of unique) {
    const key = classifyEntry(e, { categorySeeds }).type;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }

  const sampled = [];
  const entriesByBucket = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  const total = unique.length;

  for (const [, bucketEntries] of entriesByBucket) {
    const quota = Math.max(2, Math.round((bucketEntries.length / total) * maxSample));
    sampled.push(...bucketEntries.slice(0, quota));
    if (sampled.length >= maxSample) break;
  }

  if (sampled.length < maxSample) {
    for (const e of unique) {
      if (!sampled.find((x) => x.loc === e.loc)) sampled.push(e);
      if (sampled.length >= maxSample) break;
    }
  }

  return sampled.slice(0, maxSample);
}


function extractMainContentHtml(html) {
  const candidates = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]+(?:id|class)=["'][^"']*(?:content|post-content|entry-content|article-content|main-content|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<section[^>]+(?:id|class)=["'][^"']*(?:content|post-content|entry-content|article-content)[^"']*["'][^>]*>([\s\S]*?)<\/section>/i,
  ];

  for (const rgx of candidates) {
    const m = html.match(rgx);
    if (m?.[1]) return m[1];
  }

  return html;
}

function removeNonMainNoise(html) {
  return html
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<div[^>]+(?:id|class)=["'][^"']*(?:sidebar|widget|menu|breadcrumbs?|related-posts|toc)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, ' ');
}

function slugTokens(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname
      .split('/')
      .filter(Boolean)
      .join('-')
      .split(/[^a-z0-9à-ỹ]+/i)
      .map((x) => x.trim())
      .filter((x) => x && x.length >= 3);
  } catch {
    return [];
  }
}

function suggestAnchorsFromUrl(targetUrl) {
  const tokens = slugTokens(targetUrl).slice(-6);
  if (!tokens.length) return ['xem thêm bài liên quan'];
  const phrase = tokens.slice(0, 4).join(' ');
  return [
    `xem thêm: ${phrase}`,
    `hướng dẫn ${phrase}`,
    `kinh nghiệm ${phrase}`,
  ];
}

function selectRelatedUrls(current, diagnostics) {
  const currentTokens = new Set(slugTokens(current.url));
  const sameCategory = diagnostics.filter((d) => d.url !== current.url && d.parentCategory && d.parentCategory === current.parentCategory);
  const scored = sameCategory.map((d) => {
    const t = slugTokens(d.url);
    let overlap = 0;
    t.forEach((x) => { if (currentTokens.has(x)) overlap += 1; });
    return { url: d.url, overlap };
  }).sort((a, b) => b.overlap - a.overlap);

  return scored.slice(0, 3).map((x) => x.url);
}

function extractPageSignals(html, url) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || null;
  const datePublished = html.match(/(?:datePublished|article:published_time)["'\s:=]+([^"'<>\s]+)/i)?.[1] || null;
  const dateModified = html.match(/(?:dateModified|article:modified_time)["'\s:=]+([^"'<>\s]+)/i)?.[1] || null;

  const mainHtml = removeNonMainNoise(extractMainContentHtml(html));
  const breadcrumbUrls = [];
  const anchors = mainHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi) || [];

  let internalLinkCount = 0;
  let poorAnchorCount = 0;
  const poorAnchorExamples = [];
  const poorAnchorPatterns = /^(xem|click|here|tại đây|xem thêm|đọc thêm|chi tiết|xem ngay)$/i;

  for (const a of anchors.slice(0, 500)) {
    const href = a.match(/href=["']([^"']+)["']/i)?.[1];
    const anchorText = a.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!href) continue;

    let abs = '';
    try {
      abs = new URL(href, url).toString();
      const sameHost = new URL(abs).host === new URL(url).host;
      if (sameHost) internalLinkCount += 1;
      if (!breadcrumbUrls.includes(abs)) breadcrumbUrls.push(abs);
    } catch {
      continue;
    }

    const normalizedAnchor = anchorText.toLowerCase();
    const isPoor = !anchorText || poorAnchorPatterns.test(normalizedAnchor);

    if (isPoor) {
      poorAnchorCount += 1;
      if (poorAnchorExamples.length < 20) poorAnchorExamples.push({ text: anchorText || '(trống)', href: abs });
    }
  }

  const imageTags = mainHtml.match(/<img[^>]*>/gi) || [];
  const imageCount = imageTags.length;
  let imageMissingAltCount = 0;
  const missingAltImages = [];
  imageTags.forEach((img) => {
    const hasAlt = /\salt\s*=/.test(img);
    const altValue = img.match(/\salt=["']([^"']*)["']/i)?.[1] || '';
    if (!hasAlt || !altValue.trim()) {
      imageMissingAltCount += 1;
      if (missingAltImages.length < 20) missingAltImages.push(img.match(/\ssrc=["']([^"']+)["']/i)?.[1] || '(không có src)');
    }
  });

  return {
    title,
    datePublished,
    dateModified,
    breadcrumbUrls: breadcrumbUrls.slice(0, 60),
    internalLinkCount,
    poorAnchorCount,
    poorAnchorExamples,
    imageCount,
    imageMissingAltCount,
    missingAltImages,
  };
}

async function fetchPageSignals(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;
    const html = await r.text();
    return extractPageSignals(html, url);
  } catch {
    return null;
  }
}

async function enrichEntriesWithPageSignals(entries, options = {}) {
  const concurrency = Math.max(2, Math.min(12, options.concurrency || 6));
  const maxFetch = Number.isFinite(options.maxFetch) ? options.maxFetch : entries.length;
  const out = new Array(entries.length);
  let idx = 0;

  async function worker() {
    while (idx < entries.length) {
      const i = idx;
      idx += 1;
      const e = entries[i];
      if (i < maxFetch) {
        const signals = await fetchPageSignals(e.loc);
        out[i] = { ...e, pageSignals: signals || null };
      } else {
        out[i] = e;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

function buildCacheKey(sitemapUrl, mode = 'balanced', customCategoryUrls = []) {
  const suffix = (customCategoryUrls || []).map(normalizeUrl).sort().join('|');
  return crypto.createHash('sha256').update(`${sitemapUrl}:${mode}:${suffix}`).digest('hex');
}

module.exports = {
  collectUrlsFromSitemap,
  analyzeDeterministic,
  sampleUrls,
  enrichEntriesWithPageSignals,
  buildCacheKey,
};
