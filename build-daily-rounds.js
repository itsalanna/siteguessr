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
// Wayback Machine pages come with the archive.org toolbar baked into the
// page itself. Rather than depend on Wayback's `if_` URL modifier (which
// needs an exact 14-digit timestamp and is unreliable to resolve from a
// CI runner, since archive.org's lookup API intermittently rate-limits
// requests from cloud IPs), we just capture a taller screenshot and crop
// the toolbar strip off afterward. This has no external dependency and
// can't fail the way the API lookup could.
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
  // Extra height so there's room to crop the Wayback toolbar off and still
  // end up with a full SHOT_HEIGHT image.
  const page = await browser.newPage({
    viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT + WAYBACK_TOOLBAR_HEIGHT }
  });

  const roundsOut = [];

  for (const r of todays) {
    const beforeFile = `images/${r.slug}-then.png`;
    const afterFile = `images/${r.slug}-now.png`;
    const beforeUrl = `https://web.archive.org/web/${r.year}/http://${r.beforeDomain}`;

    // "Then" screenshot: crop off the top strip to remove Wayback's toolbar.
    try {
      console.log(`Capturing ${beforeFile} from ${beforeUrl} ...`);
      await page.goto(beforeUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(5000);
      await page.screenshot({
        path: path.join(outDir, beforeFile),
        clip: { x: 0, y: WAYBACK_TOOLBAR_HEIGHT, width: SHOT_WIDTH, height: SHOT_HEIGHT }
      });
      console.log(`  saved -> ${beforeFile}`);
    } catch (err) {
      console.error(`  FAILED ${beforeFile}: ${err.message}`);
    }

    // "Now" screenshot: no toolbar to crop, just take the top SHOT_HEIGHT.
    try {
      console.log(`Capturing ${afterFile} from ${r.afterUrl} ...`);
      await page.goto(r.afterUrl, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(5000);
      await page.screenshot({
        path: path.join(outDir, afterFile),
        clip: { x: 0, y: 0, width: SHOT_WIDTH, height: SHOT_HEIGHT }
      });
      console.log(`  saved -> ${afterFile}`);
    } catch (err) {
      console.error(`  FAILED ${afterFile}: ${err.message}`);
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
