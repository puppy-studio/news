import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { XMLParser } from 'fast-xml-parser';

const ROOT = '/home/claw/ghq/github.com/puppy-studio/news';
const BLOG_DIR = path.join(ROOT, 'src/content/blog');
const DATA_DIR = path.join(ROOT, 'src/data');

const CATEGORIES = [
  {
    key: 'security-jp',
    label: '情報セキュリティ（日本語圏）',
    locale: { hl: 'ja', gl: 'JP', ceid: 'JP:ja' },
    querySeeds: ['情報セキュリティ', '脆弱性', 'ランサムウェア', 'JPCERT', 'IPA']
  },
  {
    key: 'security-en',
    label: '情報セキュリティ（英語圏）',
    locale: { hl: 'en', gl: 'US', ceid: 'US:en' },
    querySeeds: ['cybersecurity', 'vulnerability', 'ransomware', 'zero-day', 'CISA']
  },
  {
    key: 'enterprise-jp',
    label: 'エンタープライズ情報システム（日本語圏）',
    locale: { hl: 'ja', gl: 'JP', ceid: 'JP:ja' },
    querySeeds: ['情シス', 'ERP', 'SaaS', 'DX', '基幹システム']
  },
  {
    key: 'enterprise-en',
    label: 'エンタープライズ情報システム（英語圏）',
    locale: { hl: 'en', gl: 'US', ceid: 'US:en' },
    querySeeds: ['enterprise IT', 'CIO', 'ERP', 'SaaS', 'digital transformation']
  },
  {
    key: 'ai',
    label: 'AI（日本語/英語ミックス）',
    locale: { hl: 'ja', gl: 'JP', ceid: 'JP:ja' },
    querySeeds: ['generative AI', 'LLM', 'AI regulation', 'foundation model', 'AIエージェント']
  },
];

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || `topic-${Date.now()}`;
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
  for (const [k, v] of Object.entries(parsed)) {
    if (!process.env[k]) process.env[k] = v;
  }
}

async function xaiChat(system, user) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY is missing');

  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-3-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) throw new Error(`xAI API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('xAI response missing content');
  return JSON.parse(content);
}

async function resolveGoogleNewsLink(url) {
  if (!url?.includes('news.google.com')) return url;

  let current = url;
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'news-bot/1.0' },
    });

    const loc = res.headers.get('location');
    if (!loc) return current;

    const next = new URL(loc, current).toString();
    if (!next.includes('news.google.com')) return next;
    current = next;
  }
  return current;
}

async function fetchGoogleNewsRss(query, locale) {
  const { hl, gl, ceid } = locale;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'news-bot/1.0' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item ?? [];
  const arr = (Array.isArray(items) ? items : [items]).filter(Boolean);

  const mapped = [];
  for (const item of arr.slice(0, 12)) {
    const googleLink = item.link;
    const resolved = await resolveGoogleNewsLink(googleLink);
    mapped.push({
      title: item.title,
      link: resolved,
      viaGoogleNews: googleLink,
      pubDate: item.pubDate,
      source: typeof item.source === 'string' ? item.source : item.source?.['#text'],
    });
  }
  return mapped;
}

function uniqueByLink(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item?.link || item?.viaGoogleNews;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildXReactionSources(topicTitle) {
  const q = encodeURIComponent(topicTitle);
  return [
    { title: 'X 検索（最新）', link: `https://x.com/search?q=${q}&src=typed_query&f=live` },
    { title: 'X 検索（話題）', link: `https://x.com/search?q=${q}&src=typed_query` },
  ];
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
      const candidates = await fetchGoogleNewsRss(topic.search_query || topic.title, cat.locale);
      const sources = uniqueByLink(candidates).slice(0, 4);
      const xReactionSources = buildXReactionSources(topic.title);

      const summary = await xaiChat(
        'You are a concise Japanese tech editor. Return strict JSON only.',
        `次のトピックを要約してください。\nトピック: ${topic.title}\n注目理由: ${topic.why_hot}\nソース: ${JSON.stringify(sources, null, 2)}\n\nJSON: {"summary":"3-4文","impact":"業務影響を1-2文","social_reaction":"X上の反応傾向を1-2文（断定しない）"}`
      );

      topicBlocks.push({
        title: topic.title,
        whyHot: topic.why_hot,
        query: topic.search_query,
        summary: summary.summary,
        impact: summary.impact,
        socialReaction: summary.social_reaction,
        sources,
        xReactionSources,
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
      mdLines.push(`- Xの反応（参考）: ${topic.socialReaction}`);
      mdLines.push('- 参照URL:');
      for (const src of topic.sources) {
        mdLines.push(`  - [${src.title}](${src.link})`);
      }
      mdLines.push('- X反応ソースURL:');
      for (const src of topic.xReactionSources) {
        mdLines.push(`  - [${src.title}](${src.link})`);
      }
      mdLines.push('');
    }
  }

  await writeFile(mdPath, `${mdLines.join('\n')}\n`, 'utf8');

  const latest = {
    generatedAt: now.toISOString(),
    title: `Tech Pulse ${date} ${hour}:${minute} UTC`,
    sections: allSections,
    postSlug,
  };
  await writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(latest, null, 2), 'utf8');

  console.log(`Generated: ${mdPath}`);
}

generate().catch((e) => {
  console.error(e);
  process.exit(1);
});
