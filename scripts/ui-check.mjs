import { chromium } from 'playwright';

const url = process.argv[2] || 'https://073c9e57.news-7n3.pages.dev';

function luminance(r, g, b) {
  const a = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function parseRgb(str) {
  const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function contrast(c1, c2) {
  const l1 = luminance(...c1);
  const l2 = luminance(...c2);
  const bright = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (bright + 0.05) / (dark + 0.05);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'ui-check.png', fullPage: true });

const report = await page.evaluate(() => {
  const selectors = [
    '.hero h1',
    '.lead',
    '.meta a',
    '.card h3',
    '.summary',
    '.subhead',
    'body'
  ];

  return selectors
    .map((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        selector: sel,
        color: s.color,
        backgroundColor: s.backgroundColor,
        fontSize: s.fontSize,
        fontFamily: s.fontFamily,
      };
    })
    .filter(Boolean);
});

const resolved = report.map((row) => {
  let bg = row.backgroundColor;
  if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
    // fallback assumptions used in this page
    if (row.selector.startsWith('.hero')) bg = 'rgb(15, 23, 42)';
    else if (row.selector === '.lead' || row.selector === '.meta a') bg = 'rgb(15, 23, 42)';
    else bg = 'rgb(255, 255, 255)';
  }
  const c = parseRgb(row.color);
  const b = parseRgb(bg);
  const ratio = c && b ? contrast(c, b) : null;
  return { ...row, bgResolved: bg, contrast: ratio };
});

console.log(JSON.stringify({ url, checks: resolved }, null, 2));
await browser.close();
