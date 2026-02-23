import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { XMLParser } from 'fast-xml-parser';

const ROOT = '/home/claw/ghq/github.com/puppy-studio/news';
const BLOG_DIR = path.join(ROOT, 'src/content/blog');
const DATA_DIR = path.join(ROOT, 'src/data');

const CATEGORIES = [
  { key: 'security-jp', label: '情報セキュリティ（日本語圏）', locale: { mkt: 'ja-JP' }, querySeeds: ['情報セキュリティ', '脆弱性', 'ランサムウェア', 'JPCERT', 'IPA'], lang: 'ja' },
  { key: 'security-en', label: '情報セキュリティ（英語圏）', locale: { mkt: 'en-US' }, querySeeds: ['cybersecurity', 'vulnerability', 'ransomware', 'zero-day', 'CISA'], lang: 'en' },
  { key: 'enterprise-jp', label: 'エンタープライズ情報システム（日本語圏）', locale: { mkt: 'ja-JP' }, querySeeds: ['情シス', 'ERP', 'SaaS', 'DX', '基幹システム'], lang: 'ja' },
  { key: 'enterprise-en', label: 'エンタープライズ情報システム（英語圏）', locale: { mkt: 'en-US' }, querySeeds: ['enterprise IT', 'CIO', 'ERP', 'SaaS', 'digital transformation'], lang: 'en' },
  { key: 'ai-jp', label: 'AI（日本語圏）', locale: { mkt: 'ja-JP' }, querySeeds: ['生成AI', 'LLM', 'AIエージェント', 'AI規制', 'AI導入'], lang: 'ja' },
  { key: 'ai-en', label: 'AI（英語圏）', locale: { mkt: 'en-US' }, querySeeds: ['generative AI', 'LLM', 'AI regulation', 'foundation model', 'AI agent'], lang: 'en' },
];

const parser = new XMLParser({ ignoreAttributes: false });

function slugify(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || `topic-${Date.now()}`;
}

function parseEnv(file) {
  const out = {};
  for (const line of file.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const [k, ...rest] = t.split('=');
    out[k.trim()] = rest.join('=').trim();
  }
  return out;
}

async function loadEnv() {
  const envFile = await readFile(path.join(ROOT, '.env'), 'utf8');
  const parsed = parseEnv(envFile);
  for (const [k, v] of Object.entries(parsed)) if (!process.env[k]) process.env[k] = v;
}

async function xaiChat(system, user) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY is missing');
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-3-mini',
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`xAI API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data?.choices?.[0]?.message?.content || '{}');
}

function decodeBingRedirect(raw) {
  try {
    const fixed = (raw || '').replace(/&amp;/g, '&');
    const u = new URL(fixed);
    return u.searchParams.get('url') || fixed;
  } catch {
    return raw;
  }
}

async function fetchNewsRss(query, locale) {
  const mkt = locale?.mkt || 'en-US';
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=${encodeURIComponent(mkt)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'news-bot/1.0' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const parsed = parser.parse(await res.text());
  const items = parsed?.rss?.channel?.item ?? [];
  const arr = (Array.isArray(items) ? items : [items]).filter(Boolean);
  return arr.slice(0, 14).map((item) => ({
    title: item.title,
    link: decodeBingRedirect(item.link),
    viaAggregator: item.link,
    pubDate: item.pubDate,
    source: item?.['News:Source'] || item.source || '',
  }));
}

async function fetchWebRss(query, locale) {
  const mkt = locale?.mkt || 'en-US';
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&mkt=${encodeURIComponent(mkt)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'news-bot/1.0' } });
  if (!res.ok) return [];
  const parsed = parser.parse(await res.text());
  const items = parsed?.rss?.channel?.item ?? [];
  const arr = (Array.isArray(items) ? items : [items]).filter(Boolean);
  return arr.map((item) => ({ title: item.title || 'X post', link: decodeBingRedirect(item.link) }));
}

function uniqueByLink(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = item?.link || item?.url || item?.viaAggregator;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

async function verifyXStatusUrl(url) {
  try {
    if (!/x\.com\/.+\/status\/\d+/.test(url)) return false;
    const endpoint = `https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(url)}`;
    const res = await fetch(endpoint, { headers: { 'User-Agent': 'news-bot/1.0' } });
    return res.ok;
  } catch {
    return false;
  }
}

async function collectRealXPosts(topicTitle, topicQuery, locale) {
  const grok = await xaiChat(
    'Return strict JSON only. Suggest likely X post URLs for this topic.',
    `トピック: ${topicTitle}\n検索ヒント: ${topicQuery}\nJSON: {"candidates":[{"url":"https://x.com/.../status/...","label":"..."}]}`
  );

  const q1 = `site:x.com/status ${topicQuery}`;
  const q2 = `site:x.com/status ${topicTitle}`;
  const webCandidates = uniqueByLink([...(await fetchWebRss(q1, locale)), ...(await fetchWebRss(q2, locale))])
    .map((i) => ({ url: i.link, label: i.title || 'X投稿' }));

  const candidates = uniqueByLink([
    ...((grok.candidates || []).map((c) => ({ url: c.url, label: c.label || 'X投稿' }))),
    ...webCandidates,
  ])
    .filter((i) => /x\.com\/.+\/status\/\d+/.test(i.url))
    .slice(0, 18);

  const verified = [];
  for (const c of candidates) {
    if (await verifyXStatusUrl(c.url)) verified.push(c);
    if (verified.length >= 6) break;
  }
  return verified;
}

async function buildAxisFromPosts(topicTitle, posts) {
  if (!posts.length) return [];
  const payload = await xaiChat(
    'You classify debate axes. Return strict JSON only.',
    `次の投稿リストから、対立軸があれば最大2軸抽出してください。\nトピック:${topicTitle}\n投稿:${JSON.stringify(posts, null, 2)}\nJSON:{"axes":[{"name":"...","indexes":[0,1,2]}]}`
  );
  return (payload.axes || [])
    .slice(0, 2)
    .map((a) => ({ name: a.name || '論点', posts: (a.indexes || []).map((i) => posts[i]).filter(Boolean).slice(0, 3) }))
    .filter((a) => a.posts.length);
}

async function addJaSummaries(posts, mustSummarize) {
  if (!mustSummarize || !posts.length) return posts;
  const payload = await xaiChat(
    'You translate X post titles/snippets into Japanese. Return strict JSON only.',
    `次を日本語1行で要約。\n${JSON.stringify(posts, null, 2)}\nJSON:{"items":[{"index":0,"ja":"..."}]}`
  );
  const map = new Map((payload.items || []).map((i) => [i.index, i.ja]));
  return posts.map((p, idx) => ({ ...p, ja_summary: map.get(idx) || '' }));
}

async function fetchXEvidence(topicTitle, topicQuery, cat) {
  const rawPosts = await collectRealXPosts(topicTitle, topicQuery, cat.locale);
  const hotBase = rawPosts.slice(0, 3);
  const hotPosts = await addJaSummaries(hotBase, cat.lang === 'en' || cat.lang === 'mix');
  const axisBucketsBase = await buildAxisFromPosts(topicTitle, rawPosts.slice(0, 6));
  const axisBuckets = [];
  for (const ax of axisBucketsBase) {
    axisBuckets.push({
      name: ax.name,
      posts: await addJaSummaries(ax.posts.slice(0, 3), cat.lang === 'en' || cat.lang === 'mix'),
    });
  }

  return {
    method: 'bing+x-url-verification',
    rationale: `X投稿URLを外部検索から抽出後、実URL検証して採用（有効件数: ${rawPosts.length}）`,
    hotPosts,
    axisBuckets,
  };
}

async function generate() {
  await loadEnv();
  await mkdir(BLOG_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(11, 13);
  const minute = now.toISOString().slice(14, 16);
  const allSections = [];

  for (const cat of CATEGORIES) {
    const topicPayload = await xaiChat(
      'You are an editor. Return strict JSON only.',
      `次のカテゴリで直近6時間のホットトピックを2件返してください。\nカテゴリ: ${cat.label}\n検索キーワード候補: ${cat.querySeeds.join(', ')}\nJSON形式: {"topics":[{"title":"...","why_hot":"...","search_query":"..."}]}`
    );

    const topics = (topicPayload.topics || []).slice(0, 2);
    const topicBlocks = [];

    for (const topic of topics) {
      const sources = uniqueByLink(await fetchNewsRss(topic.search_query || topic.title, cat.locale)).slice(0, 4);
      const xEvidence = await fetchXEvidence(topic.title, topic.search_query || topic.title, cat);

      const summary = await xaiChat(
        'You are a concise Japanese tech editor. Return strict JSON only.',
        `次のトピックを要約してください。\nトピック: ${topic.title}\n注目理由: ${topic.why_hot}\nソース: ${JSON.stringify(sources, null, 2)}\nXデータ: ${JSON.stringify(xEvidence, null, 2)}\n\nJSON: {"summary":"3-4文","impact":"業務影響を1-2文","social_reaction":"X上の反応傾向を1-2文（断定しない）"}`
      );

      topicBlocks.push({
        title: topic.title,
        whyHot: topic.why_hot,
        query: topic.search_query,
        summary: summary.summary,
        impact: summary.impact,
        socialReaction: summary.social_reaction,
        sources,
        xEvidence,
      });
    }
    allSections.push({ key: cat.key, label: cat.label, topics: topicBlocks });
  }

  const postSlug = slugify(`${date}-${hour}${minute}-tech-pulse`);
  const mdPath = path.join(BLOG_DIR, `${postSlug}.md`);

  const mdLines = [
    '---',
    `title: "Tech Pulse ${date} ${hour}:${minute} UTC"`,
    'description: "情報セキュリティ・エンタープライズIT・AIの注目トピックまとめ"',
    `pubDate: ${now.toISOString()}`,
    'heroImage: "../../assets/blog-placeholder-1.jpg"',
    '---',
    '',
    `更新時刻: ${now.toISOString()}`,
    '',
  ];

  for (const section of allSections) {
    mdLines.push(`## ${section.label}`, '');
    for (const topic of section.topics) {
      mdLines.push(`### ${topic.title}`, '');
      mdLines.push(`- 何が起きたか: ${topic.summary}`);
      mdLines.push(`- 業務影響: ${topic.impact}`);
      mdLines.push(`- Xの反応: ${topic.socialReaction}`);
      mdLines.push('- 参照URL:');
      for (const src of topic.sources) mdLines.push(`  - [${src.title}](${src.link})`);
      mdLines.push('- X選定根拠:');
      mdLines.push(`  - ${topic.xEvidence.rationale}`);
      mdLines.push('- Xホット投稿URL:');
      for (const p of topic.xEvidence.hotPosts || []) {
        mdLines.push(`  - [${p.label}](${p.url})`);
        if (p.ja_summary) mdLines.push(`    - 日本語要約: ${p.ja_summary}`);
      }
      if ((topic.xEvidence.axisBuckets || []).length) {
        mdLines.push('- 対立軸ごとのホット投稿:');
        for (const ax of topic.xEvidence.axisBuckets) {
          mdLines.push(`  - ${ax.name}`);
          for (const p of ax.posts) {
            mdLines.push(`    - [${p.label}](${p.url})`);
            if (p.ja_summary) mdLines.push(`      - 日本語要約: ${p.ja_summary}`);
          }
        }
      }
      mdLines.push('');
    }
  }

  await writeFile(mdPath, `${mdLines.join('\n')}\n`, 'utf8');
  await writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify({ generatedAt: now.toISOString(), title: `Tech Pulse ${date} ${hour}:${minute} UTC`, sections: allSections, postSlug }, null, 2), 'utf8');
  console.log(`Generated: ${mdPath}`);
}

generate().catch((e) => {
  console.error(e);
  process.exit(1);
});
