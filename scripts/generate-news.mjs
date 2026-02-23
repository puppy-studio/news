import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { XMLParser } from 'fast-xml-parser';

const ROOT = '/home/claw/ghq/github.com/puppy-studio/news';
const BLOG_DIR = path.join(ROOT, 'src/content/blog');
const DATA_DIR = path.join(ROOT, 'src/data');

const CATEGORIES = [
  {
    key: 'security',
    label: '情報セキュリティ',
    geo: ['日本', '世界'],
    querySeeds: ['cybersecurity', 'ransomware', 'vulnerability', 'zero-day', '情報セキュリティ']
  },
  {
    key: 'enterprise',
    label: 'エンタープライズ情報システム',
    geo: ['日本', '世界'],
    querySeeds: ['enterprise IT', 'CIO', 'SaaS', 'ERP', 'DX', '情シス']
  },
  {
    key: 'ai',
    label: 'AI',
    geo: ['日本', '世界'],
    querySeeds: ['generative AI', 'LLM', 'AI regulation', 'foundation model', 'AI agent']
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
    .slice(0, 70) || `topic-${Date.now()}`;
}

function parseEnv(file) {
  const out = {};
  const lines = file.split(/\r?\n/);
  for (const line of lines) {
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
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'grok-3-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_object' }
    })
  });

  if (!res.ok) {
    throw new Error(`xAI API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('xAI response missing content');
  return JSON.parse(content);
}

async function fetchGoogleNewsRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
  const res = await fetch(url, { headers: { 'User-Agent': 'news-bot/1.0' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item ?? [];
  const arr = Array.isArray(items) ? items : [items];
  return arr
    .filter(Boolean)
    .map((it) => ({
      title: it.title,
      link: it.link,
      pubDate: it.pubDate,
      source: typeof it.source === 'string' ? it.source : it.source?.['#text']
    }));
}

function uniqueByLink(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.link || seen.has(item.link)) continue;
    seen.add(item.link);
    out.push(item);
  }
  return out;
}

async function generate() {
  await loadEnv();
  await mkdir(BLOG_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const hourStamp = now.toISOString().slice(11, 13);

  const allSections = [];

  for (const cat of CATEGORIES) {
    const topicPayload = await xaiChat(
      'You are an editor. Return strict JSON only.',
      `以下カテゴリの直近24時間で注目すべき話題を3つ返してください。\nカテゴリ: ${cat.label}\n地域: ${cat.geo.join(' / ')}\n参考キーワード: ${cat.querySeeds.join(', ')}\nJSON形式: {"topics":[{"title":"...","why_hot":"...","search_query":"..."}]}`
    );

    const topics = (topicPayload.topics || []).slice(0, 3);
    const topicBlocks = [];

    for (const topic of topics) {
      const candidates = await fetchGoogleNewsRss(topic.search_query || topic.title);
      const sources = uniqueByLink(candidates).slice(0, 5);

      const summary = await xaiChat(
        'You are a concise Japanese tech editor. Return strict JSON only.',
        `次のトピックを要約してください。\nトピック: ${topic.title}\nなぜ注目: ${topic.why_hot}\n参考ソース: ${JSON.stringify(sources, null, 2)}\n\n出力JSON: {"summary":"3-5文の日本語要約","impact":"業務影響を1-2文","social_reaction":"SNS上の反応傾向を1-2文で推定（断定しない）"}`
      );

      topicBlocks.push({
        title: topic.title,
        whyHot: topic.why_hot,
        query: topic.search_query,
        summary: summary.summary,
        impact: summary.impact,
        socialReaction: summary.social_reaction,
        sources,
      });
    }

    allSections.push({
      key: cat.key,
      label: cat.label,
      topics: topicBlocks,
    });
  }

  const mdLines = [];
  mdLines.push('---');
  mdLines.push(`title: "Tech Pulse ${date} ${hourStamp}:00 UTC"`);
  mdLines.push(`description: "情報セキュリティ・エンタープライズIT・AIの注目トピックまとめ"`);
  mdLines.push(`pubDate: ${now.toISOString()}`);
  mdLines.push(`heroImage: "../../assets/blog-placeholder-1.jpg"`);
  mdLines.push('---\n');
  mdLines.push(`更新時刻: ${now.toISOString()}\n`);

  for (const section of allSections) {
    mdLines.push(`## ${section.label}`);
    mdLines.push('');
    for (const t of section.topics) {
      mdLines.push(`### ${t.title}`);
      mdLines.push('');
      mdLines.push(`- 何が起きたか: ${t.summary}`);
      mdLines.push(`- 業務影響: ${t.impact}`);
      mdLines.push(`- SNS反応（参考）: ${t.socialReaction}`);
      mdLines.push('- 参照URL:');
      for (const s of t.sources) {
        mdLines.push(`  - [${s.title}](${s.link})`);
      }
      mdLines.push('');
    }
  }

  const fileBase = `${date}-${hourStamp}00-tech-pulse`;
  const mdPath = path.join(BLOG_DIR, `${slugify(fileBase)}.md`);
  await writeFile(mdPath, mdLines.join('\n') + '\n', 'utf8');

  const latest = {
    generatedAt: now.toISOString(),
    title: `Tech Pulse ${date} ${hourStamp}:00 UTC`,
    sections: allSections,
    postSlug: slugify(fileBase),
  };
  await writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(latest, null, 2), 'utf8');

  console.log(`Generated: ${mdPath}`);
}

generate().catch((e) => {
  console.error(e);
  process.exit(1);
});
