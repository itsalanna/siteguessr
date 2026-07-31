// build-daily-rounds.js
//
// Run this once a day (GitHub Actions does this automatically, see
// .github/workflows/daily.yml). It:
//   1. Picks 5 rounds from rounds-pool.json, seeded by today's UTC date,
//      so everyone playing on a given day sees the same 5 rounds.
//   2. Captures a fresh "then" and "now" screenshot for each.
//   3. Writes rounds-data.json, which index.html loads at runtime.
//
// rounds-pool.json grows on its own over time (see grow-pool.js and
// .github/workflows/grow-pool.yml), so this file never needs manual edits.
//
// Two things Wayback Machine pages need handling for:
//  1. The archive.org toolbar is baked into the page itself, so we
//     capture a taller screenshot and crop that strip off.
//  2. The shorthand year URL (web.archive.org/web/1999/http://...)
//     redirects to whatever snapshot Wayback considers "closest," which
//     can land on a genuinely broken/incomplete capture (some old
//     snapshots never saved their images). We verify the page actually
//     has visible content before accepting it, and try alternate
//     snapshots from that same year via the CDX API if the first one
//     turns out blank.
//
// LOCAL RUN (macOS with an older OS version that Playwright's bundled
// Chromium doesn't support):
//   PLAYWRIGHT_CHANNEL=chrome node build-daily-rounds.js
// LOCAL RUN (everything else) / CI:
//   node build-daily-rounds.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const pool = JSON.parse(fs.readFileSync(path.join(__dirname, 'rounds-pool.json'), 'utf8'));

const ROUNDS_PER_DAY = 5;
const SHOT_WIDTH = 1200;
const SHOT_HEIGHT = 800;
const WAYBACK_TOOLBAR_HEIGHT = 100; // px cropped off the top of archived pages
const MAX_SNAPSHOT_ATTEMPTS = 4;

// Deterministic seeded PRNG (mulberry32-ish) so the same date always
// produces the same shuffle, but different dates produce different ones.
function makeRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seedStr) {
  const rng = makeRng(seedStr);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Lists candidate snapshot timestamps for a domain within a given year,
// via Wayback's CDX API. Returns them spread across the year (not just
// the first few crawled) so retries actually try meaningfully different
// captures rather than near-duplicates from the same week.
async function getSnapshotTimestamps(domain, year) {
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&from=${year}0101&to=${year}1231&output=json&filter=statuscode:200&collapse=timestamp:6&limit=30`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    const rows = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length < 2) return [];
    const timestamps = rows.slice(1).map(row => row[1]);
    // Spread picks across the list instead of just taking the first few.
    const picks = [];
    const step = Math.max(1, Math.floor(timestamps.length / MAX_SNAPSHOT_ATTEMPTS));
    for (let i = 0; i < timestamps.length && picks.length < MAX_SNAPSHOT_ATTEMPTS; i += step) {
      picks.push(timestamps[i]);
    }
    return picks;
  } catch (err) {
    console.error(`  CDX lookup failed for ${domain}: ${err.message}`);
    return [];
  }
}

async function isUsableSnapshot(page) {
  try {
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    const trimmed = text.trim();
    if (trimmed.length <= 40) return false;
    const lower = trimmed.toLowerCase();
    // Wayback's own "still loading, redirecting to..." interstitial has
    // plenty of text on it, but it isn't the archived page itself.
    if (lower.includes('got an http') && lower.includes('redirecting to')) return false;
    if (lower.includes('wayback machine has not archived')) return false;
    return true;
  } catch {
    return false;
  }
}

async function captureBefore(page, domain, year, outPath) {
  let candidates = await getSnapshotTimestamps(domain, year);
  if (candidates.length === 0) candidates = [`${year}0601000000`]; // last-resort guess

  for (const ts of candidates) {
    const url = `https://web.archive.org/web/${ts}/http://${domain}`;
    try {
      console.log(`  trying snapshot ${ts} ...`);
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(4000);
      if (await isUsableSnapshot(page)) {
        await page.screenshot({
          path: outPath,
          clip: { x: 0, y: WAYBACK_TOOLBAR_HEIGHT, width: SHOT_WIDTH, height: SHOT_HEIGHT }
        });
        console.log(`  snapshot ${ts} looked good, saved.`);
        return true;
      }
      console.log(`  snapshot ${ts} appears blank/broken, trying next...`);
    } catch (err) {
      console.log(`  snapshot ${ts} failed to load: ${err.message}`);
    }
  }

  console.error(`  No usable snapshot found for ${domain} in ${year} after ${candidates.length} attempts.`);
  return false;
}

async function captureAfter(page, url, outPath) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(attempt === 1 ? 5000 : 9000);
      const usable = await isUsableSnapshot(page);
      if (usable || attempt === 2) {
        await page.screenshot({
          path: outPath,
          clip: { x: 0, y: 0, width: SHOT_WIDTH, height: SHOT_HEIGHT }
        });
        if (!usable) console.log(`  ${url} still looked sparse after retry, saved anyway.`);
        return true;
      }
      console.log(`  ${url} looked blank on attempt ${attempt}, retrying with a longer wait...`);
    } catch (err) {
      console.error(`  FAILED attempt ${attempt} for ${url}: ${err.message}`);
    }
  }
  return false;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10); // e.g. "2026-08-01" (UTC)
  const shuffled = seededShuffle(pool, today);
  const todays = shuffled.slice(0, Math.min(ROUNDS_PER_DAY, pool.length));

  const outDir = __dirname;
  const imagesDir = path.join(outDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const launchOptions = process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {};
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({
    viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT + WAYBACK_TOOLBAR_HEIGHT }
  });

  const roundsOut = [];

  for (const r of todays) {
    const beforeFile = `images/${r.slug}-then.png`;
    const afterFile = `images/${r.slug}-now.png`;

    console.log(`Capturing ${beforeFile} (${r.beforeDomain}, ~${r.year}) ...`);
    await captureBefore(page, r.beforeDomain, r.year, path.join(outDir, beforeFile));

    console.log(`Capturing ${afterFile} from ${r.afterUrl} ...`);
    await captureAfter(page, r.afterUrl, path.join(outDir, afterFile));

    roundsOut.push({
      answer: r.answer,
      year: r.year,
      accept: r.accept,
      fact: r.fact,
      beforeImg: beforeFile,
      afterImg: afterFile
    });
  }

  await browser.close();

  const data = { date: today, rounds: roundsOut };
  fs.writeFileSync(path.join(outDir, 'rounds-data.json'), JSON.stringify(data, null, 2));
  console.log(`Wrote rounds-data.json for ${today} with ${roundsOut.length} rounds.`);
}

main();
