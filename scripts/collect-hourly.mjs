import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const ROOT = '/home/claw/ghq/github.com/puppy-studio/news';
const DATA_DIR = path.join(ROOT, 'src/data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'hourly-snapshots.jsonl');

const CATEGORIES = [
  { key: 'security-jp', locale: { mkt: 'ja-JP' }, querySeeds: ['JPCERT 注意喚起', 'IPA 脆弱性', 'CVE 影響', '不正アクセス 公表'] },
  { key: 'security-en', locale: { mkt: 'en-US' }, querySeeds: ['CVE critical', 'CISA advisory', 'zero-day exploit', 'data breach disclosed'] },
  { key: 'enterprise-jp', locale: { mkt: 'ja-JP' }, querySeeds: ['Microsoft 365 障害', 'AWS 障害', '基幹システム 移行', '情シス 障害'] },
  { key: 'enterprise-en', locale: { mkt: 'en-US' }, querySeeds: ['enterprise SaaS outage', 'Microsoft 365 incident', 'cloud migration enterprise', 'CIO strategy'] },
  { key: 'ai-jp', locale: { mkt: 'ja-JP' }, querySeeds: ['OpenAI 新機能', 'Claude 新機能', 'Gemini 新機能', 'Codex 新機能', 'Kimi 発表', 'GLM 発表'] },
  { key: 'ai-en', locale: { mkt: 'en-US' }, querySeeds: ['OpenAI feature release', 'Claude new feature', 'Gemini update', 'Codex update', 'Kimi AI release', 'GLM model update', 'DeepSeek update'] },
];

const parser = new XMLParser({ ignoreAttributes: false });

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
  return ts >= Date.now() - days * 86400000;
}

async function fetchNewsRss(query, locale) {
  const mkt = locale?.mkt || 'en-US';
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=${encodeURIComponent(mkt)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'news-hourly-collector/1.0' } });
  if (!res.ok) return [];
  const parsed = parser.parse(await res.text());
  const items = parsed?.rss?.channel?.item ?? [];
  const arr = (Array.isArray(items) ? items : [items]).filter(Boolean);
  return arr
    .map((item) => ({
      title: item.title,
      link: decodeBingRedirect(item.link),
      pubDate: item.pubDate,
      source: item?.['News:Source'] || item.source || '',
    }))
    .filter((x) => isWithinDays(x.pubDate, 7))
    .filter((x) => !/joomla/i.test(`${x.title} ${x.link}`))
    .slice(0, 12);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const snapshot = {
    collectedAt: new Date().toISOString(),
    categories: {},
  };

  for (const cat of CATEGORIES) {
    const collected = [];
    for (const q of cat.querySeeds) {
      const rows = await fetchNewsRss(q, cat.locale);
      for (const r of rows) collected.push({ ...r, query: q });
    }
    const dedup = [];
    const seen = new Set();
    for (const r of collected) {
      if (!r.link || seen.has(r.link)) continue;
      seen.add(r.link);
      dedup.push(r);
    }
    snapshot.categories[cat.key] = dedup.slice(0, 30);
  }

  let prev = '';
  try { prev = await readFile(SNAPSHOT_PATH, 'utf8'); } catch {}
  await writeFile(SNAPSHOT_PATH, prev + JSON.stringify(snapshot) + '\n', 'utf8');

  console.log(`hourly snapshot saved: ${SNAPSHOT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
