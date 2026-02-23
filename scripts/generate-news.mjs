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

function metricScore(metrics = {}) {
  return (metrics.like_count || 0) + (metrics.retweet_count || 0) * 2 + (metrics.reply_count || 0) * 1.5 + (metrics.quote_count || 0) * 2;
}

async function fetchXEvidence(query) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return { available: false, reason: 'X_BEARER_TOKEN missing', sampleSize: 0, estimatedPosts24h: null, hotPosts: [], axisBuckets: [] };

  const q = `${query} -is:retweet lang:ja OR lang:en`;
  const endpoint = new URL('https://api.x.com/2/tweets/search/recent');
  endpoint.searchParams.set('query', q);
  endpoint.searchParams.set('max_results', '50');
  endpoint.searchParams.set('tweet.fields', 'created_at,public_metrics,lang,author_id');
  endpoint.searchParams.set('expansions', 'author_id');
  endpoint.searchParams.set('user.fields', 'username,name');

  const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { available: false, reason: `x api error ${res.status}`, sampleSize: 0, estimatedPosts24h: null, hotPosts: [], axisBuckets: [] };

  const json = await res.json();
  const tweets = json.data || [];
  const users = new Map((json.includes?.users || []).map((u) => [u.id, u]));

  const enriched = tweets.map((t) => {
    const user = users.get(t.author_id);
    return {
      id: t.id,
      text: t.text,
      lang: t.lang,
      metrics: t.public_metrics || {},
      score: metricScore(t.public_metrics || {}),
      author: user?.username || 'unknown',
      url: `https://x.com/${user?.username || 'i'}/status/${t.id}`,
    };
  }).sort((a, b) => b.score - a.score);

  const hotPosts = enriched.slice(0, 3);

  const axis = await xaiChat(
    'You classify debate axes from social posts. Return strict JSON only.',
    `次のX投稿サンプルから対立軸を抽出し、軸ごとに該当投稿IDを返してください。\n投稿: ${JSON.stringify(enriched.slice(0, 20), null, 2)}\nJSON: {"axes":[{"name":"...","post_ids":["id1","id2"]}]}`
  );

  const axisBuckets = (axis.axes || []).slice(0, 2).map((a) => ({
    name: a.name,
    posts: (a.post_ids || []).map((id) => enriched.find((e) => e.id === id)).filter(Boolean).slice(0, 3),
  })).filter((a) => a.posts.length > 0);

  const estimatedPosts24h = tweets.length ? Math.round((tweets.length / 7) * 24) : 0;
  return { available: true, reason: null, sampleSize: tweets.length, estimatedPosts24h, hotPosts, axisBuckets };
}

async function jaSummariesForEnglishPosts(posts) {
  if (!posts.length) return [];
  const payload = await xaiChat(
    'You are a translator. Return strict JSON only.',
    `次の英語ポストを日本語で1行ずつ要約してください。\n${JSON.stringify(posts, null, 2)}\nJSON: {"items":[{"id":"...","ja":"..."}]}`
  );
  return payload.items || [];
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
      const xEvidence = await fetchXEvidence(topic.search_query || topic.title);

      const summary = await xaiChat(
        'You are a concise Japanese tech editor. Return strict JSON only.',
        `次のトピックを要約してください。\nトピック: ${topic.title}\n注目理由: ${topic.why_hot}\nソース: ${JSON.stringify(sources, null, 2)}\nXデータ: ${JSON.stringify(xEvidence, null, 2)}\n\nJSON: {"summary":"3-4文","impact":"業務影響を1-2文","social_reaction":"X上の反応傾向を1-2文（断定しない）"}`
      );

      let hotPostJaSummaries = [];
      if (cat.lang === 'en' || cat.lang === 'mix') {
        hotPostJaSummaries = await jaSummariesForEnglishPosts(xEvidence.hotPosts.map((p) => ({ id: p.id, text: p.text })));
      }

      topicBlocks.push({
        title: topic.title,
        whyHot: topic.why_hot,
        query: topic.search_query,
        summary: summary.summary,
        impact: summary.impact,
        socialReaction: summary.social_reaction,
        sources,
        xEvidence,
        hotPostJaSummaries,
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
      mdLines.push(`  - 取得件数(サンプル): ${topic.xEvidence.sampleSize}`);
      mdLines.push(`  - 推定24h投稿数: ${topic.xEvidence.estimatedPosts24h ?? 'N/A'}`);
      if (!topic.xEvidence.available) mdLines.push(`  - 備考: ${topic.xEvidence.reason}`);
      mdLines.push('- Xホット投稿URL:');
      for (const p of topic.xEvidence.hotPosts || []) {
        mdLines.push(`  - [@${p.author} / ♥${p.metrics.like_count ?? 0} RT${p.metrics.retweet_count ?? 0}](${p.url})`);
      }
      if ((topic.hotPostJaSummaries || []).length) {
        mdLines.push('- 英語圏ポストの日本語要約:');
        for (const it of topic.hotPostJaSummaries) mdLines.push(`  - ${it.ja}`);
      }
      if ((topic.xEvidence.axisBuckets || []).length) {
        mdLines.push('- 対立軸ごとのホット投稿:');
        for (const ax of topic.xEvidence.axisBuckets) {
          mdLines.push(`  - ${ax.name}`);
          for (const p of ax.posts) mdLines.push(`    - [@${p.author} / ♥${p.metrics.like_count ?? 0} RT${p.metrics.retweet_count ?? 0}](${p.url})`);
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
