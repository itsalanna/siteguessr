// build-daily-rounds.js
//
// Run this once a day (GitHub Actions does this automatically, see
// .github/workflows/daily.yml). It:
//   1. Picks 5 rounds from rounds-pool.json, seeded by today's UTC date,
//      so everyone playing on a given day sees the same 5 rounds. If a
//      round's screenshots genuinely can't be captured, it's swapped
//      for the next candidate in the shuffled pool rather than shipping
//      a broken round.
//   2. Captures a fresh "then" and "now" screenshot for each.
//   3. Writes archive/{date}.json (that day's rounds) and updates
//      archive/index.json (the list of all playable dates), so past
//      days stay permanently playable instead of being overwritten.
//
// Each day's screenshots live in their own folder (images/{date}/...)
// rather than a shared images/ folder, specifically so a new day's
// build never overwrites a previous day's images out from under the
// archive.
//
// rounds-pool.json grows on its own over time (see grow-pool.js and
// .github/workflows/grow-pool.yml), so this file never needs manual edits.
//
// Handling for Wayback Machine quirks:
//  1. The archive.org toolbar is baked into the page itself. Its height
//     varies from page to page, so we measure the actual toolbar
//     element and crop exactly that much.
//  2. The shorthand year URL redirects to whatever snapshot Wayback
//     considers "closest," which can land on a broken/incomplete
//     capture or Wayback's own "redirecting..." interstitial. We check
//     for real content (not just the interstitial, and not just a
//     sparse nav-only page) before accepting a snapshot, trying
//     alternates from the CDX API if needed.
//  3. The site's own name/logo is usually the biggest giveaway in a
//     "guess the company" screenshot, so on the "then" shot we look for
//     and cover on-page text, image alt text, id/class hints, and
//     header-zone images/backgrounds that match the answer.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const pool = JSON.parse(fs.readFileSync(path.join(__dirname, 'rounds-pool.json'), 'utf8'));

const ROUNDS_PER_DAY = 5;
const SHOT_WIDTH = 1200;
const SHOT_HEIGHT = 800;
const DEFAULT_TOOLBAR_HEIGHT = 100;
const VIEWPORT_HEADROOM = 300;
const MAX_SNAPSHOT_ATTEMPTS = 4;

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

async function getSnapshotTimestamps(domain, year) {
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&from=${year}0101&to=${year}1231&output=json&filter=statuscode:200&collapse=timestamp:6&limit=30`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    const rows = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length < 2) return [];
    const timestamps = rows.slice(1).map(row => row[1]);
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

// A page is "usable" if it has substantial text AND isn't Wayback's own
// interstitial page. The higher text threshold (vs. the old 40 chars)
// avoids accepting a nearly-blank page that just happens to have a nav
// bar with enough characters in it.
async function isUsableSnapshot(page) {
  try {
    const result = await page.evaluate(() => {
      const text = document.body ? document.body.innerText.trim() : '';
      const loadedImages = Array.from(document.querySelectorAll('img'))
        .filter(img => img.naturalWidth > 20 && img.naturalHeight > 20).length;
      return { textLength: text.length, lower: text.toLowerCase(), loadedImages };
    });
    if (result.lower.includes('got an http') && result.lower.includes('redirecting to')) return false;
    if (result.lower.includes('wayback machine has not archived')) return false;
    // Accept if there's a solid amount of text, OR a decent amount of
    // text plus at least one real loaded image (covers image-heavy
    // homepages with comparatively little text).
    if (result.textLength > 150) return true;
    if (result.textLength > 40 && result.loadedImages >= 1) return true;
    return false;
  } catch {
    return false;
  }
}

async function getToolbarHeight(page) {
  try {
    const height = await page.evaluate(() => {
      const el = document.querySelector('#wm-ipp-base') || document.querySelector('#wm-ipp');
      return el ? Math.ceil(el.getBoundingClientRect().height) : null;
    });
    if (height && height > 20 && height < 250) return height;
  } catch {
    // fall through to default
  }
  return DEFAULT_TOOLBAR_HEIGHT;
}

// Finds on-page text, image alt/title text, id/class hints, and
// header-zone images or CSS background-images that match the answer or
// its aliases, and covers those regions with a solid box.
async function coverBrandMentions(page, names, toolbarHeight) {
  const patterns = names.filter(Boolean).map(n => n.toLowerCase().trim()).filter(n => n.length > 0);
  try {
    await page.evaluate(({ patterns, toolbarHeight }) => {
      function isMatch(text) {
        if (!text) return false;
        const t = text.trim().toLowerCase();
        if (!t) return false;
        return patterns.some(p => t === p || (p.length > 2 && t.includes(p)));
      }
      function cover(rect) {
        if (rect.width <= 0 || rect.height <= 0) return;
        const div = document.createElement('div');
        div.style.position = 'fixed';
        div.style.left = rect.left + 'px';
        div.style.top = rect.top + 'px';
        div.style.width = rect.width + 'px';
        div.style.height = rect.height + 'px';
        div.style.background = '#c8c8c8';
        div.style.zIndex = '2147483647';
        div.style.borderRadius = '3px';
        document.body.appendChild(div);
      }

      // 1. Visible text matching the answer or an alias.
      document.querySelectorAll('body *').forEach(el => {
        if (el.childElementCount > 0) return;
        const text = el.textContent;
        if (isMatch(text) && text.trim().length < 60) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 700 && rect.height < 220) cover(rect);
        }
      });

      // 2. Images whose alt/title matches.
      document.querySelectorAll('img').forEach(img => {
        if (isMatch(img.alt) || isMatch(img.title)) cover(img.getBoundingClientRect());
      });

      // 3. Anything whose id/class hints at being a logo/brand element -
      // catches unlabeled logo images and CSS-background logos. Sized
      // generously since a legitimate logo/masthead container can
      // reasonably span a good chunk of the header.
      document.querySelectorAll('*').forEach(el => {
        const idcls = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
        if (/logo|brand|masthead|sitename|wordmark|identity/.test(idcls)) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 900 && rect.height < 300) cover(rect);
        }
      });

      // 4. Any reasonably-sized image in the header zone, image-based
      // logo or not, labeled or not - most homepage logos live here.
      document.querySelectorAll('img').forEach(img => {
        const rect = img.getBoundingClientRect();
        const topInContent = rect.top - toolbarHeight;
        if (topInContent >= -10 && topInContent < 160 &&
            rect.width >= 20 && rect.width <= 500 &&
            rect.height >= 10 && rect.height <= 180) {
          cover(rect);
        }
      });

      // 5. Any element in the header zone with a CSS background-image -
      // catches sprite/background-image logos regardless of id/class.
      document.querySelectorAll('body *').forEach(el => {
        const rect = el.getBoundingClientRect();
        const topInContent = rect.top - toolbarHeight;
        if (topInContent < -10 || topInContent > 160) return;
        if (rect.width < 15 || rect.width > 500 || rect.height < 10 || rect.height > 180) return;
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') cover(rect);
      });
    }, { patterns, toolbarHeight });
  } catch (err) {
    console.error(`  Brand-covering step failed (non-fatal): ${err.message}`);
  }
}

async function captureBefore(page, domain, year, outPath, brandNames) {
  let candidates = await getSnapshotTimestamps(domain, year);
  if (candidates.length === 0) candidates = [`${year}0601000000`];

  for (const ts of candidates) {
    const url = `https://web.archive.org/web/${ts}/http://${domain}`;
    try {
      console.log(`  trying snapshot ${ts} ...`);
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(6000); // give slow-loading images time to settle
      if (await isUsableSnapshot(page)) {
        const toolbarHeight = await getToolbarHeight(page);
        await coverBrandMentions(page, brandNames, toolbarHeight);
        // Cover again immediately before the shot - catches anything
        // that only finished loading/resizing between the first pass
        // and now.
        await page.waitForTimeout(300);
        await coverBrandMentions(page, brandNames, toolbarHeight);
        await page.screenshot({
          path: outPath,
          clip: { x: 0, y: toolbarHeight, width: SHOT_WIDTH, height: SHOT_HEIGHT }
        });
        console.log(`  snapshot ${ts} looked good (toolbar height ${toolbarHeight}px), saved.`);
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

// Tries to capture a full round (both screenshots). Returns the round
// data on success, or null if either shot genuinely never worked out -
// callers should skip a null and try a different pool entry instead of
// shipping a broken round to players.
async function tryCaptureRound(page, r, today, outDir) {
  const beforeFile = `images/${today}/${r.slug}-then.png`;
  const afterFile = `images/${today}/${r.slug}-now.png`;
  const brandNames = [r.answer, ...(r.accept || [])];

  console.log(`Capturing ${beforeFile} (${r.beforeDomain}, ~${r.year}) ...`);
  const beforeOk = await captureBefore(page, r.beforeDomain, r.year, path.join(outDir, beforeFile), brandNames);
  if (!beforeOk) {
    console.error(`  Skipping ${r.slug}: no usable "then" screenshot.`);
    return null;
  }

  console.log(`Capturing ${afterFile} from ${r.afterUrl} ...`);
  const afterOk = await captureAfter(page, r.afterUrl, path.join(outDir, afterFile));
  if (!afterOk) {
    console.error(`  Skipping ${r.slug}: no usable "now" screenshot.`);
    return null;
  }

  return {
    answer: r.answer,
    year: r.year,
    accept: r.accept,
    fact: r.fact,
    beforeImg: beforeFile,
    afterImg: afterFile
  };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const shuffled = seededShuffle(pool, today);

  const outDir = __dirname;
  const dateImagesDir = path.join(outDir, 'images', today);
  const archiveDir = path.join(outDir, 'archive');
  fs.mkdirSync(dateImagesDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const launchOptions = process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {};
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({
    viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT + VIEWPORT_HEADROOM }
  });

  const roundsOut = [];
  let poolIndex = 0;

  while (roundsOut.length < Math.min(ROUNDS_PER_DAY, pool.length) && poolIndex < shuffled.length) {
    const candidate = shuffled[poolIndex];
    poolIndex++;
    const round = await tryCaptureRound(page, candidate, today, outDir);
    if (round) {
      roundsOut.push(round);
    } else {
      console.error(`  Trying a replacement for the pool slot ${candidate.slug} filled...`);
    }
  }

  await browser.close();

  if (roundsOut.length === 0) {
    console.error('No rounds were successfully captured today. Not writing an archive file.');
    process.exit(1);
  }

  const data = { date: today, rounds: roundsOut };
  fs.writeFileSync(path.join(archiveDir, `${today}.json`), JSON.stringify(data, null, 2));
  console.log(`Wrote archive/${today}.json with ${roundsOut.length} rounds.`);

  const indexPath = path.join(archiveDir, 'index.json');
  let dates = [];
  if (fs.existsSync(indexPath)) {
    try {
      dates = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!Array.isArray(dates)) dates = [];
    } catch {
      dates = [];
    }
  }
  if (!dates.includes(today)) dates.push(today);
  dates.sort().reverse();
  fs.writeFileSync(indexPath, JSON.stringify(dates, null, 2));
  console.log(`Updated archive/index.json (${dates.length} date(s) total).`);
}

main();
