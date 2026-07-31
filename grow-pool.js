// grow-pool.js
//
// Runs weekly (see .github/workflows/grow-pool.yml) so rounds-pool.json
// grows on its own without you ever editing it by hand.
//
// What it does:
//   1. Asks Claude (Haiku 4.5) for a handful of new candidate sites that
//      aren't already in the pool.
//   2. For each candidate, checks the Wayback Machine's availability API
//      to confirm a real archived snapshot actually exists near the
//      claimed year. Candidates that fail this check are discarded, so
//      a hallucinated year or a site with no archive never makes it in.
//   3. Appends the survivors to rounds-pool.json and stops.
//
// Requires an ANTHROPIC_API_KEY environment variable (set as a GitHub
// secret in the workflow). Get a key at https://console.anthropic.com

const fs = require('fs');
const path = require('path');

const POOL_PATH = path.join(__dirname, 'rounds-pool.json');
const CANDIDATES_PER_RUN = 5;
const MODEL = 'claude-haiku-4-5-20251001';

async function askClaudeForCandidates(existingAnswers) {
  const prompt = `You are helping build a "guess the old website design" trivia game.

Suggest ${CANDIDATES_PER_RUN} NEW well-known websites or apps whose homepage design changed a lot over the years. Do NOT suggest any of these, they are already in the game: ${existingAnswers.join(', ')}.

For each one, respond with a JSON array of objects with exactly these fields:
- "slug": lowercase-hyphen id, e.g. "twitter"
- "answer": the display name, e.g. "Twitter"
- "year": a specific past year (a number) when its homepage looked notably different from today, where you are genuinely confident the Wayback Machine has an archived snapshot from around that year. Prefer years where you are certain, not your best guess.
- "accept": array of 3-5 lowercase strings a player might reasonably type as a correct guess
- "fact": one or two sentences of a fun, verifiable fact about that era of the product
- "domain": the bare domain, e.g. "twitter.com" (no https://, no www)

Return ONLY the JSON array. No markdown fences, no commentary, nothing else.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const text = data.content.map(b => b.text || '').join('');
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// Confirms a real Wayback Machine snapshot exists for `domain` within a
// couple years of `year`. Returns the actual snapshot year/url if so,
// or null if nothing trustworthy was found.
async function waybackHasSnapshot(domain, year) {
  const timestamp = `${year}0601`;
  const url = `https://archive.org/wayback/available?url=${encodeURIComponent(domain)}&timestamp=${timestamp}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    const closest = data.archived_snapshots && data.archived_snapshots.closest;
    if (!closest || !closest.available) return null;
    const closestYear = parseInt(closest.timestamp.slice(0, 4), 10);
    if (Math.abs(closestYear - year) > 2) return null;
    return { snapshotYear: closestYear };
  } catch (err) {
    console.error(`  Wayback check failed for ${domain}: ${err.message}`);
    return null;
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Add it as a GitHub repo secret.');
    process.exit(1);
  }

  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  const existingAnswers = pool.map(r => r.answer);
  const existingSlugs = new Set(pool.map(r => r.slug));

  console.log(`Current pool size: ${pool.length}`);
  console.log('Asking Claude for new candidates...');
  const candidates = await askClaudeForCandidates(existingAnswers);
  console.log(`Received ${candidates.length} candidate(s).`);

  const additions = [];
  for (const c of candidates) {
    if (!c.slug || !c.answer || !c.year || !c.domain) {
      console.log(`  Skipping malformed candidate: ${JSON.stringify(c)}`);
      continue;
    }
    if (existingSlugs.has(c.slug)) {
      console.log(`  Skipping duplicate: ${c.slug}`);
      continue;
    }
    console.log(`  Checking Wayback snapshot for ${c.domain} (~${c.year})...`);
    const snap = await waybackHasSnapshot(c.domain, c.year);
    if (!snap) {
      console.log(`  No trustworthy snapshot found, discarding ${c.slug}`);
      continue;
    }
    additions.push({
      slug: c.slug,
      answer: c.answer,
      year: snap.snapshotYear,
      accept: Array.isArray(c.accept) && c.accept.length ? c.accept : [c.answer.toLowerCase()],
      fact: c.fact || '',
      beforeUrl: `https://web.archive.org/web/${snap.snapshotYear}/http://${c.domain}`,
      afterUrl: `https://${c.domain}`
    });
    existingSlugs.add(c.slug);
    console.log(`  Added ${c.slug} (verified snapshot year: ${snap.snapshotYear})`);
  }

  if (additions.length === 0) {
    console.log('No valid new candidates this run. Pool unchanged.');
    return;
  }

  const updated = pool.concat(additions);
  fs.writeFileSync(POOL_PATH, JSON.stringify(updated, null, 2));
  console.log(`Added ${additions.length} new round(s). Pool size now ${updated.length}.`);
}

main();
