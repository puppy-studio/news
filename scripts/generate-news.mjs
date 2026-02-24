import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { XMLParser } from 'fast-xml-parser';

const ROOT = '/home/claw/ghq/github.com/puppy-studio/news';
const BLOG_DIR = path.join(ROOT, 'src/content/blog');
const DATA_DIR = path.join(ROOT, 'src/data');

const CATEGORIES = [
  { key: 'security-jp', label: '情報セキュリティ（日本語圏）', locale: { mkt: 'ja-JP' }, querySeeds: ['JPCERT 注意喚起', 'IPA 脆弱性', 'CVE 影響', '不正アクセス 公表'], lang: 'ja' },
  { key: 'security-en', label: '情報セキュリティ（英語圏）', locale: { mkt: 'en-US' }, querySeeds: ['CVE critical', 'CISA advisory', 'zero-day exploit', 'data breach disclosed'], lang: 'en' },
  { key: 'enterprise-jp', label: 'エンタープライズ情報システム（日本語圏）', locale: { mkt: 'ja-JP' }, querySeeds: ['Microsoft 365 障害', 'AWS 障害', '基幹システム 移行', '情シス 障害'], lang: 'ja' },
  { key: 'enterprise-en', label: 'エンタープライズ情報システム（英語圏）', locale: { mkt: 'en-US' }, querySeeds: ['enterprise SaaS outage', 'Microsoft 365 incident', 'cloud migration enterprise', 'CIO strategy'], lang: 'en' },
  { key: 'ai-jp', label: 'AI（日本語圏）', locale: { mkt: 'ja-JP' }, querySeeds: ['GPT リリース', 'Claude update', 'Gemini 発表', 'AI規制 法案'], lang: 'ja' },
  { key: 'ai-en', label: 'AI（英語圏）', locale: { mkt: 'en-US' }, querySeeds: ['GPT release', 'Claude update', 'Gemini announcement', 'foundation model release'], lang: 'en' },
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

function isWithinDays(pubDate, days = 7) {
  if (!pubDate) return false;
  const ts = Date.parse(pubDate);
  if (Number.isNaN(ts)) return false;
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return ts >= cutoff && ts <= now + 10 * 60 * 1000;
}

async function fetchNewsRss(query, locale) {
  const mkt = locale?.mkt || 'en-US';
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=${encodeURIComponent(mkt)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'news-bot/1.0' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const parsed = parser.parse(await res.text());
  const items = parsed?.rss?.channel?.item ?? [];
  const arr = (Array.isArray(items) ? items : [items]).filter(Boolean);
  return arr
    .slice(0, 30)
    .map((item) => ({
      title: item.title,
      link: decodeBingRedirect(item.link),
      viaAggregator: item.link,
      pubDate: item.pubDate,
      source: item?.['News:Source'] || item.source || '',
    }))
    .filter((item) => isWithinDays(item.pubDate, 7))
    .slice(0, 14);
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

function tightenReactionTone(text = '') {
  return String(text)
    .replace(/可能性があります/g, '傾向が見られます')
    .replace(/可能性がある/g, '傾向がある')
    .replace(/かもしれません/g, 'です')
    .replace(/兆候が見られるかもしれません/g, '兆候が見られます')
    .trim();
}

function enrichSummary(summary = '', sources = []) {
  const s = String(summary).trim();
  if (s.length >= 70) return s;
  const srcNames = sources.map((x) => x?.source).filter(Boolean).slice(0, 2).join('・');
  const suffix = srcNames
    ? ` 主要ソースは${srcNames}。詳細は参照URLを確認。`
    : ' 詳細は参照URLを確認。';
  return (s || '関連トピックが継続的に話題化。') + suffix;
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
      `次のカテゴリでX上で話題のトピックを2件返してください。\nカテゴリ: ${cat.label}\n検索キーワード候補: ${cat.querySeeds.join(', ')}\n\n制約:\n- 出力は必ず日本語\n- タイトルも必ず日本語で書く（英語原文は使わない）\n- 要約は薄くしない。2〜4文で「何が起きたか / 影響対象 / いま注目される理由」を具体化\n- 可能なら固有名詞（組織名・製品名・脆弱性識別子など）を入れる\n- 「直近6時間」「可能性」「かもしれない」など曖昧・説明的な語は不要\n\nJSON形式: {"topics":[{"title_ja":"...","summary_ja":"日本語で2-4文、具体的に","x_reaction_ja":"Xでの反応を日本語で1-2文、具体的に","search_query":"..."}]}`
    );

    const topics = (topicPayload.topics || []).slice(0, 2);
    const topicBlocks = [];

    for (const topic of topics) {
      const sources = uniqueByLink(await fetchNewsRss(topic.search_query || topic.title, cat.locale)).slice(0, 4);

      topicBlocks.push({
        title: topic.title_ja || topic.title || '',
        whyHot: topic.summary_ja || topic.why_hot || '',
        query: topic.search_query,
        summary: enrichSummary(topic.summary_ja || topic.why_hot || '', sources),
        socialReaction: tightenReactionTone(topic.x_reaction_ja || topic.summary_ja || topic.why_hot || ''),
        sources,
        xEvidence: { hotPosts: [], axisBuckets: [] },
      });
    }
    if (topicBlocks.length > 0) allSections.push({ key: cat.key, label: cat.label, topics: topicBlocks });
  }

  const postSlug = slugify(`${date}-${hour}${minute}-tech-pulse`);
  const mdPath = path.join(BLOG_DIR, `${postSlug}.md`);

  const mdLines = [
    '---',
    `title: "ITニュースダイジェスト ${date} ${hour}:${minute} UTC"`,
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
      // 業務影響セクションは非表示
      mdLines.push(`- Xの反応: ${topic.socialReaction}`);
      mdLines.push('- 参照URL:');
      for (const src of topic.sources) mdLines.push(`  - [${src.title}](${src.link})`);
      // X選定根拠は非表示
      // Xホット投稿URLは非表示
      mdLines.push('');
    }
  }

  await writeFile(mdPath, `${mdLines.join('\n')}\n`, 'utf8');
  await writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify({ generatedAt: now.toISOString(), title: `ITニュースダイジェスト ${date} ${hour}:${minute} UTC`, sections: allSections, postSlug }, null, 2), 'utf8');
  console.log(`Generated: ${mdPath}`);
}

generate().catch((e) => {
  console.error(e);
  process.exit(1);
});
