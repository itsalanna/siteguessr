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

// The `if_` URL modifier (which hides Wayback's own toolbar) only works
// reliably when attached to the FULL 14-digit snapshot timestamp, not a
// shorthand year. So instead of guessing a shorthand URL, look up the
// exact timestamp via Wayback's availability API right before capturing.
async function resolveWaybackUrl(domain, year) {
  const timestamp = `${year}0601`;
  const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(domain)}&timestamp=${timestamp}`;
  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    const closest = data.archived_snapshots && data.archived_snapshots.closest;
    if (closest && closest.available && closest.timestamp) {
      return `https://web.archive.org/web/${closest.timestamp}if_/http://${domain}`;
    }
  } catch (err) {
    console.error(`  Wayback lookup failed for ${domain}: ${err.message}`);
  }
  // Fallback: shorthand year URL without the if_ modifier. Not ideal
  // (the toolbar will show), but keeps the round playable if the
  // availability API has a hiccup.
  console.error(`  Falling back to shorthand URL for ${domain} (toolbar will be visible)`);
  return `https://web.archive.org/web/${year}/http://${domain}`;
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

  const roundsOut = [];

  for (const r of todays) {
    const beforeFile = `images/${r.slug}-then.png`;
    const afterFile = `images/${r.slug}-now.png`;

    console.log(`Resolving exact Wayback timestamp for ${r.beforeDomain} (~${r.year})...`);
    const beforeUrl = await resolveWaybackUrl(r.beforeDomain, r.year);

    for (const [url, file] of [[beforeUrl, beforeFile], [r.afterUrl, afterFile]]) {
      const outPath = path.join(outDir, file);
      try {
        console.log(`Capturing ${file} from ${url} ...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: outPath });
        console.log(`  saved -> ${outPath}`);
      } catch (err) {
        console.error(`  FAILED ${file}: ${err.message}`);
      }
    }

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
