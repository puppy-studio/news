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
  { key: 'ai', label: 'AI（日本語/英語ミックス）', locale: { mkt: 'en-US' }, querySeeds: ['generative AI', 'LLM', 'AI regulation', 'foundation model', 'AIエージェント'], lang: 'mix' },
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
  const xml = await res.text();
  const parsed = parser.parse(xml);
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

function uniqueByLink(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = item?.link || item?.viaAggregator;
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

async function fetchXEvidence(topicTitle, topicQuery, langHint) {
  const payload = await xaiChat(
    'You are a social signal curator. Return strict JSON only. Only include plausible X post URLs with /status/.',
    `対象トピック: ${topicTitle}\n検索ヒント: ${topicQuery}\n言語ヒント: ${langHint}\n\n次をJSONで返してください。\n1) トピック採用の根拠（短文）\n2) ホット投稿URLを2〜3件\n3) 対立軸がある場合は軸ごとに2〜3件\n4) 英語投稿には日本語1行要約\n\nJSON schema:\n{\n  "rationale": "...",\n  "hotPosts": [{"url":"https://x.com/.../status/...","label":"...","ja_summary":"..."}],\n  "axisBuckets": [{"name":"...","posts":[{"url":"https://x.com/.../status/...","label":"...","ja_summary":"..."}]}]\n}`
  );

  const valid = (arr = []) => arr
    .filter((x) => typeof x?.url === 'string' && /x\.com\/.+\/status\/\d+/.test(x.url))
    .slice(0, 3)
    .map((x) => ({ url: x.url, label: x.label || '投稿', ja_summary: x.ja_summary || '' }));

  const hotPosts = valid(payload.hotPosts || []);
  const axisBuckets = (payload.axisBuckets || [])
    .slice(0, 2)
    .map((a) => ({ name: a.name || '論点', posts: valid(a.posts || []) }))
    .filter((a) => a.posts.length > 0);

  return {
    method: 'grok-curated',
    rationale: payload.rationale || 'X上での話題性が高い投稿を抽出',
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
      `次のカテゴリで直近24時間のホットトピックを2件返してください。\nカテゴリ: ${cat.label}\n検索キーワード候補: ${cat.querySeeds.join(', ')}\nJSON形式: {"topics":[{"title":"...","why_hot":"...","search_query":"..."}]}`
    );

    const topics = (topicPayload.topics || []).slice(0, 2);
    const topicBlocks = [];

    for (const topic of topics) {
      const sources = uniqueByLink(await fetchNewsRss(topic.search_query || topic.title, cat.locale)).slice(0, 4);
      const xEvidence = await fetchXEvidence(topic.title, topic.search_query || topic.title, cat.lang);

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
