import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/home/claw/ghq/github.com/puppy-studio/news';
const latestPath = path.join(ROOT, 'src/data/latest.json');

function hasJa(text = '') {
  return /[ぁ-んァ-ヶ一-龠]/.test(text);
}

function checkTopic(section, topic) {
  const issues = [];
  const body = `${topic.title || ''} ${topic.summary || ''} ${topic.socialReaction || ''}`;

  if (!hasJa(topic.title || '')) issues.push('タイトルが日本語でない');
  if (/\b(ABC|XYZ|Sample|サンプル企業)\b/i.test(body)) issues.push('プレースホルダ語を検出');
  if (!topic.sources || topic.sources.length === 0) issues.push('ソースURLが0件');

  if (section.label?.includes('英語圏') && /(日本政府|日本国内|日本で可決|国内法案)/.test(body)) {
    issues.push('英語圏セクションに日本国内文脈の混入疑い');
  }

  return issues;
}

async function main() {
  const latest = JSON.parse(await readFile(latestPath, 'utf8'));
  const sections = latest.sections || [];
  const report = [];

  for (const section of sections) {
    for (const topic of section.topics || []) {
      const issues = checkTopic(section, topic);
      if (issues.length) report.push({ section: section.label, title: topic.title, issues });
    }
  }

  if (report.length) {
    console.log(JSON.stringify({ ok: false, report }, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify({ ok: true, checkedSections: sections.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
