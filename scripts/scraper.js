/**
 * RepubliChud Index — Scraper v3
 *
 * Pipeline:
 *   1. INIT (once per figure): Wikipedia HTML → parse sections + reference URLs → Groq extract
 *   2. ONGOING (every 6h): GDELT + CourtListener + Congress.gov + RSS → Groq extract
 *   3. Within-batch consolidation: Groq merges duplicate events into single entries w/ multiple sources
 *   4. 5-day window consolidation: Groq compares new entries against last 5 days of existing entries
 *   5. String dedup: free safety net against ALL existing entries
 *   6. Per-figure git commit
 *
 * Data format:
 *   { date, fact, sources: [{ name, url }] }
 *
 * Environment: GROQ_API_KEY (required), runs in GitHub Actions (Node 20+)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ============================================================
// CONFIG
// ============================================================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const DATA_DIR = path.join(__dirname, '..', 'data');
const FIGURES_PATH = path.join(__dirname, '..', 'figures.json');

// ============================================================
// UTILITIES
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// RATE LIMITER
// ============================================================
class RateLimiter {
  constructor() {
    this.lastCall = {};
    this.delays = {
      gdelt: 6000,       // GDELT: "one request every 5 seconds"
      courtlistener: 1000,
      congress: 500,
      rss: 300,
      groq: 2000,        // ~30 calls/min target; 429s handled by withRetry
      wikipedia: 1000,
    };
  }
  async wait(source) {
    const minDelay = this.delays[source] || 1000;
    const elapsed = Date.now() - (this.lastCall[source] || 0);
    if (elapsed < minDelay) await sleep(minDelay - elapsed);
    this.lastCall[source] = Date.now();
  }
}
const limiter = new RateLimiter();

// ============================================================
// RETRY: 429s retry until 120s timeout. Other errors fail immediately.
// 120s = 2 × Groq's 60s rate limit window.
// ============================================================
const RETRY_TIMEOUT_MS = 120_000;

async function withRetry(fn, { label = '' } = {}) {
  const deadline = Date.now() + RETRY_TIMEOUT_MS;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.message.includes('429') || err.message.includes('rate_limit');
      if (!is429) throw err;
      if (Date.now() >= deadline) throw err;
      let waitMs = 5000;
      const match = err.message.match(/try again in ([\d.]+)s/);
      if (match) waitMs = Math.ceil(parseFloat(match[1]) * 1000) + 500;
      const remaining = deadline - Date.now();
      if (waitMs > remaining) waitMs = remaining;
      console.log(`    [retry] ${label} — waiting ${(waitMs / 1000).toFixed(1)}s (${(remaining / 1000).toFixed(0)}s left)`);
      await sleep(waitMs);
    }
  }
}

// ============================================================
// HTTP
// ============================================================
function httpGet(url, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req = mod.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'RepubliChudIndex/3.0 (github.com)', ...headers },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        resolve(httpGet(redirectUrl, headers, maxRedirects - 1));
        return;
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}: ${url}\n${body.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.end();
  });
}

function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let responseBody = '';
      res.on('data', c => responseBody += c);
      res.on('end', () => {
        clearTimeout(hardTimer);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(responseBody);
        else reject(new Error(`HTTP ${res.statusCode}: ${url}\n${responseBody.slice(0, 500)}`));
      });
    });
    req.on('error', err => { clearTimeout(hardTimer); reject(err); });
    // Hard 90s total-request deadline (req.setTimeout is idle-only and won't fire on slow streams)
    const hardTimer = setTimeout(() => { req.destroy(); reject(new Error(`Timeout: ${url}`)); }, 90000);
    req.write(body);
    req.end();
  });
}

// ============================================================
// GROQ CALLER (rate limited + retry)
// ============================================================
async function callGroq(prompt, maxTokens = 4000) {
  await limiter.wait('groq');
  const raw = await withRetry(
    () => httpPost(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: maxTokens },
      { Authorization: `Bearer ${GROQ_API_KEY}` }
    ),
    { label: 'Groq' }
  );
  const result = JSON.parse(raw);
  return result.choices?.[0]?.message?.content?.trim() || '';
}

function parseGroqJson(content) {
  if (!content) return [];
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// ============================================================
// XML/RSS PARSER
// ============================================================
function parseRssItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    items.push({
      title: tag(b, 'title'), link: tag(b, 'link'),
      description: tag(b, 'description'), pubDate: tag(b, 'pubDate'),
    });
  }
  return items;
}
function tag(xml, name) {
  const re = new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>|<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`);
  const m = re.exec(xml);
  return m ? (m[1] || m[2] || '').trim() : '';
}

// ============================================================
// SOURCE: WIKIPEDIA (initialization)
// Fetches HTML with references, parses into sections, extracts via Groq.
// ============================================================
async function fetchWikipediaHtml(articleSlug) {
  await limiter.wait('wikipedia');
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${articleSlug}&prop=text|sections&format=json&disabletoc=true`;
  try {
    const raw = await httpGet(url);
    const data = JSON.parse(raw);
    return data.parse?.text?.['*'] || '';
  } catch (err) {
    console.error(`  [Wikipedia] ${err.message.split('\n')[0]}`);
    return '';
  }
}

function extractReferencesFromHtml(html) {
  // Build a map: ref number → URL
  const refs = {};

  // Quick sanity check before running the full regex
  // Wikipedia HTML-encodes underscores in id attributes as &#95; (e.g. cite&#95;note-)
  // but uses literal underscores in href attributes
  if (!html.includes('cite_note-') && !html.includes('cite&#95;note-')) return refs;

  // Match reference list items. Wikipedia encodes underscores in id as &#95;
  // e.g. <li id="cite&#95;note-3"> or <li class="..." id="cite&#95;note-...">
  // We split on </li> and process each chunk individually.
  const parts = html.split('</li>');
  for (const part of parts) {
    const liMatch = part.match(/<li\b[^>]*\bid="(cite(?:_|&#95;)note-[^"]*)"[^>]*>([\s\S]*)/);
    if (!liMatch) continue;
    // Decode HTML entities in id to match the literal-underscore refs extracted from hrefs in body text
    const refId = liMatch[1]
      .replace(/^cite(?:_|&#95;)note-/, '')
      .replace(/&#95;/g, '_')
      .replace(/&#44;/g, ',')
      .replace(/&amp;/g, '&');
    const refContent = liMatch[2];
    // Find external URLs (https:// or protocol-relative //)
    const urlRegex = /href="((?:https?:)?\/\/[^"]+)"/g;
    let urlMatch;
    const urls = [];
    while ((urlMatch = urlRegex.exec(refContent)) !== null) {
      let u = urlMatch[1];
      if (u.startsWith('//')) u = 'https:' + u;
      u = u.replace(/&amp;/g, '&');
      // Skip Wikipedia internal links and archive links
      if (!u.includes('wikipedia.org') && !u.includes('web.archive.org/web/')) {
        urls.push(u);
      }
    }
    if (urls.length > 0) refs[refId] = urls[0]; // First external URL is the source
  }
  return refs;
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<sup[^>]*class="reference"[^>]*>[\s\S]*?<\/sup>/gi, (match) => {
      // Preserve reference markers for mapping
      const idMatch = match.match(/cite_note-([^"]*)/);
      return idMatch ? ` [REF:${idMatch[1]}] ` : '';
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkText(text, maxChars = 6000) {
  const chunks = [];
  const sentences = text.split(/(?<=\.\s)/);
  let current = '';
  for (const s of sentences) {
    if (current.length + s.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// Shared criteria used by both Wikipedia init and ongoing article extraction.
// Both prompts must capture the same things — character-focused, not category-focused.
const ENTRY_CRITERIA = `statements, quotes, or admissions of harmful or offensive behavior; ` +
  `votes for discriminatory or harmful policy; votes against civil rights or protections for vulnerable groups; ` +
  `lawsuits, criminal charges, convictions, civil judgments, settlements, or indictments; ` +
  `corruption, fraud, bribery, or abuse of power; ethical violations; ` +
  `sexual misconduct or assault allegations; documented lies or deliberate disinformation; ` +
  `policies that caused documented harm to people; or any action that reflects abuse of public trust or disregard for human dignity`;

const ENTRY_EXCLUSIONS = `Do NOT include: winning elections, receiving nominations, neutral biographical facts (birthplace, education, family), ` +
  `or procedural/non-controversial votes (e.g. naming buildings, uncontested bipartisan measures), ` +
  `or campaign events with no harmful content. ` +
  `IMPORTANT: A vote FOR harmful or discriminatory policy is NOT a routine vote — include it. ` +
  `An offensive statement made at a campaign event is NOT a neutral campaign event — include it.`;

async function extractFromWikipedia(articleSlugs, figureName, figureSlug) {
  const allEntries = [];

  for (const slug of articleSlugs) {
    console.log(`    Fetching Wikipedia: ${slug}`);
    const html = await fetchWikipediaHtml(slug);
    if (!html) continue;

    // Extract reference URLs
    const refs = extractReferencesFromHtml(html);
    console.log(`    → ${Object.keys(refs).length} references found`);

    // Strip HTML but keep reference markers
    const text = stripHtml(html);

    // Build reference context for Groq
    const refContext = Object.entries(refs)
      .map(([id, url]) => `REF:${id} → ${url}`)
      .join('\n');

    // Chunk the text
    const chunks = chunkText(text, 5000);
    console.log(`    → ${chunks.length} chunks to process`);

    for (let i = 0; i < chunks.length; i++) {
      process.stdout.write(`    chunk ${i + 1}/${chunks.length}...`);

      const prompt = `You are extracting entries for a political accountability database about ${figureName}.

Read this Wikipedia section. For each clear, documented instance of: ${ENTRY_CRITERIA} — extract an entry.

${ENTRY_EXCLUSIONS}

The text contains [REF:id] markers. Use the reference map below to find the source URL for each fact.

Return a JSON array. Each entry:
{"date":"YYYY-MM-DD","fact":"one sentence, objective, specific","sources":[{"name":"publication name","url":"source URL from reference map"}]}

For dates: use exact dates when given (e.g. "On January 6, 2021" → "2021-01-06"). If only month/year, use the 1st (e.g. "In March 2019" → "2019-03-01"). If only year, use Jan 1 (e.g. "In 2005" → "2005-01-01").

For sources: match [REF:id] markers to the reference map. If no matching ref, use {"name":"Wikipedia","url":"https://en.wikipedia.org/wiki/${slug}"}.

Return [] if nothing relevant. Return ONLY valid JSON.

Reference map:
${refContext.slice(0, 3000)}

Text:
${chunks[i]}`;

      try {
        const content = await callGroq(prompt);
        const entries = parseGroqJson(content).filter(e => e.date && e.fact && e.sources);
        allEntries.push(...entries);
        console.log(` ${entries.length} entries`);
      } catch (err) {
        console.log(` FAILED: ${err.message.split('\n')[0].slice(0, 80)}`);
      }
    }
  }

  return allEntries;
}

// ============================================================
// SOURCE: GDELT
// ============================================================
async function fetchGdelt(figureName, isHistorical) {
  await limiter.wait('gdelt');
  const query = encodeURIComponent(`"${figureName}"`);
  const timespan = isHistorical ? '' : '&timespan=6h';
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}+sourcelang:english&mode=artlist&maxrecords=250&format=json${timespan}`;
  try {
    const raw = await withRetry(() => httpGet(url), { label: 'GDELT' });
    const data = JSON.parse(raw);
    return (data.articles || []).map(a => ({
      title: a.title || '', url: a.url || '',
      source: a.domain || a.source || 'GDELT',
      date: a.seendate ? a.seendate.slice(0, 8) : '',
      snippet: a.title || '',
    }));
  } catch (err) {
    console.error(`  [GDELT] ${err.message.split('\n')[0]}`);
    return [];
  }
}

// ============================================================
// SOURCE: COURTLISTENER
// ============================================================
async function fetchCourtListener(figureName) {
  await limiter.wait('courtlistener');
  const url = `https://www.courtlistener.com/api/rest/v4/search/?q=${encodeURIComponent(figureName)}&type=o&format=json&order_by=dateFiled+desc&page_size=50`;
  try {
    const raw = await httpGet(url);
    const data = JSON.parse(raw);
    return (data.results || []).map(r => ({
      title: r.caseName || r.case_name || '',
      url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : '',
      source: 'CourtListener',
      date: r.dateFiled || r.date_filed || '',
      snippet: r.snippet || r.caseName || r.case_name || '',
    }));
  } catch (err) {
    console.error(`  [CourtListener] ${err.message.split('\n')[0]}`);
    return [];
  }
}

// ============================================================
// SOURCE: CONGRESS.GOV
// ============================================================
async function fetchCongress(figureName) {
  await limiter.wait('congress');
  const url = `https://api.congress.gov/v3/bill?query=${encodeURIComponent(figureName)}&limit=50&format=json&api_key=DEMO_KEY`;
  try {
    const raw = await httpGet(url);
    const data = JSON.parse(raw);
    return (data.bills || []).map(b => ({
      title: b.title || '',
      url: b.url || `https://congress.gov/bill/${b.congress}th-congress/${b.type?.toLowerCase()}/${b.number}`,
      source: 'Congress.gov',
      date: b.latestAction?.actionDate || b.updateDate || '',
      snippet: `${b.title || ''} — ${b.latestAction?.text || ''}`,
    }));
  } catch (err) {
    console.error(`  [Congress] ${err.message.split('\n')[0]}`);
    return [];
  }
}

// ============================================================
// SOURCE: RSS FEEDS
// ============================================================
const RSS_FEEDS = [
  { name: 'AP News', url: 'https://feedx.net/rss/ap.xml' },
  { name: 'NPR Politics', url: 'https://feeds.npr.org/1014/rss.xml' },
  { name: 'PBS NewsHour', url: 'https://www.pbs.org/newshour/feeds/rss/politics' },
  { name: 'The Hill', url: 'https://thehill.com/feed/' },
];

async function fetchRssForFigure(figureName) {
  const results = [];
  const nameLower = figureName.toLowerCase();
  const lastName = figureName.split(' ').pop().toLowerCase();
  for (const feed of RSS_FEEDS) {
    await limiter.wait('rss');
    try {
      const xml = await httpGet(feed.url);
      for (const item of parseRssItems(xml)) {
        const text = `${item.title} ${item.description}`.toLowerCase();
        if (text.includes(nameLower) || text.includes(lastName)) {
          results.push({
            title: item.title, url: item.link, source: feed.name,
            date: item.pubDate ? new Date(item.pubDate).toISOString().slice(0, 10) : '',
            snippet: `${item.title}. ${item.description}`.slice(0, 500),
          });
        }
      }
    } catch (err) {
      console.error(`  [RSS/${feed.name}] ${err.message.split('\n')[0]}`);
    }
  }
  return results;
}

// ============================================================
// GROQ: EXTRACT from news/court/congress articles
// Returns { entries: [...], failedBatches, totalBatches }
// ============================================================
const FIGURE_SLUGS = {};

async function extractFromArticles(articles) {
  const entries = [];
  let failedBatches = 0;
  const BATCH_SIZE = 3;
  const totalBatches = Math.ceil(articles.length / BATCH_SIZE);

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    const articlesText = batch
      .map((a, idx) => `[${idx + 1}] ${a.title} | ${a.source} | ${a.date} | ${a.url}\n${a.snippet}`)
      .join('\n\n');

    const figureList = Object.entries(FIGURE_SLUGS).map(([name, slug]) => `${name}`).join(', ');

    const prompt = `You are extracting entries for a political accountability database.

For each article containing a clear, documented instance of: ${ENTRY_CRITERIA} — by: ${figureList}

${ENTRY_EXCLUSIONS}

Return a JSON array. Each entry:
{"figure":"<slug>","date":"YYYY-MM-DD","fact":"one sentence, objective, specific","sources":[{"name":"publication","url":"article URL"}]}

Valid slugs: ${Object.values(FIGURE_SLUGS).join(', ')}
If nothing relevant, return []. Return ONLY valid JSON.

${articlesText}`;

    try {
      process.stdout.write(`    batch ${batchNum}/${totalBatches}...`);
      const content = await callGroq(prompt);
      const valid = parseGroqJson(content).filter(e => e.figure && e.date && e.fact && e.sources);
      entries.push(...valid);
      console.log(` ${valid.length} entries`);
    } catch (err) {
      failedBatches++;
      console.log(` FAILED: ${err.message.split('\n')[0].slice(0, 80)}`);
    }
  }

  return { entries, failedBatches, totalBatches };
}

// ============================================================
// CONSOLIDATION
// Within-batch: merge duplicate events into single entries w/ multiple sources.
// 5-day window: compare new entries against recent existing entries.
// ============================================================
async function consolidateEntries(entries) {
  if (entries.length <= 1) return entries;

  // Process in chunks to keep prompts manageable
  const CHUNK = 30;
  let consolidated = [];

  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const entriesJson = JSON.stringify(chunk);

    const prompt = `You are consolidating entries for a political accountability database.

Multiple entries may describe the same event from different sources. Merge them:
- Same event → one entry, combine all sources into the sources array, use the earliest date
- Different events → keep separate

Return a JSON array of consolidated entries. Each:
{"date":"YYYY-MM-DD","fact":"one clean sentence","sources":[{"name":"pub","url":"url"},...]}

Return ONLY valid JSON.

Entries:
${entriesJson}`;

    try {
      const content = await callGroq(prompt);
      const result = parseGroqJson(content).filter(e => e.date && e.fact && e.sources);
      consolidated.push(...(result.length > 0 ? result : chunk));
    } catch (err) {
      console.error(`    [Consolidate] ${err.message.split('\n')[0].slice(0, 80)}`);
      consolidated.push(...chunk); // On failure, keep originals
    }
  }

  return consolidated;
}

async function consolidateAgainstRecent(newEntries, existingEntries) {
  if (newEntries.length === 0) return newEntries;

  // 5-day window: only compare against entries from the last 5 days
  const fiveDaysAgo = new Date();
  fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
  const cutoff = fiveDaysAgo.toISOString().slice(0, 10);

  const recentExisting = existingEntries.filter(e => e.date >= cutoff);

  if (recentExisting.length === 0) return newEntries;

  const prompt = `You are deduplicating entries for a political accountability database.

EXISTING entries (last 5 days):
${JSON.stringify(recentExisting.map(e => ({ date: e.date, fact: e.fact })))}

NEW entries to check:
${JSON.stringify(newEntries)}

For each NEW entry:
- If it describes the same event as an EXISTING entry, mark it with "merge_with_date" and "merge_with_fact" of the existing entry, and include the new sources.
- If it's a new event, keep it as-is.

Return a JSON array. Each entry:
{"date":"YYYY-MM-DD","fact":"sentence","sources":[...],"merge_with_date":"existing date or null","merge_with_fact":"first 60 chars of existing fact or null"}

Return ONLY valid JSON.`;

  try {
    const content = await callGroq(prompt);
    const results = parseGroqJson(content);

    const toInsert = [];
    const toMerge = [];

    for (const r of results) {
      if (r.merge_with_date && r.merge_with_fact) {
        toMerge.push(r);
      } else {
        toInsert.push({ date: r.date, fact: r.fact, sources: r.sources || [] });
      }
    }

    // Apply merges: add new sources to existing entries
    for (const m of toMerge) {
      const existing = existingEntries.find(e =>
        e.date === m.merge_with_date &&
        e.fact.toLowerCase().slice(0, 60) === (m.merge_with_fact || '').toLowerCase().slice(0, 60)
      );
      if (existing && m.sources) {
        const existingUrls = new Set((existing.sources || []).map(s => s.url));
        for (const src of m.sources) {
          if (!existingUrls.has(src.url)) {
            existing.sources = existing.sources || [];
            existing.sources.push(src);
          }
        }
      }
    }

    return toInsert;
  } catch (err) {
    console.error(`    [5-day consolidate] ${err.message.split('\n')[0].slice(0, 80)}`);
    return newEntries; // On failure, treat all as new
  }
}

// ============================================================
// STRING DEDUP: free safety net against all existing entries
// ============================================================
function stringDedup(existing, incoming) {
  const keys = new Set(existing.map(e => `${e.date}|${e.fact.toLowerCase().slice(0, 60)}`));
  return incoming.filter(e => {
    const k = `${e.date}|${e.fact.toLowerCase().slice(0, 60)}`;
    if (keys.has(k)) return false;
    keys.add(k);
    return true;
  });
}

// ============================================================
// SUMMARY GENERATION
// ============================================================
async function generateSummary(entries, figureName) {
  if (!entries || entries.length === 0) return '';
  const entriesText = entries
    .slice(0, 100) // Cap at 100 entries to stay within token limits
    .map(e => `- [${e.date}] ${e.fact}`)
    .join('\n');

  return await callGroq(
    `You are writing a character summary for a political accountability database.

Based only on these documented entries, write 3-5 sentences about ${figureName}'s character and pattern of behavior. Be direct and fierce. State what the facts show. Do not editorialize beyond what the entries support. Do not use hedging language.

Entries:
${entriesText}

Return only the summary text, nothing else.`, 500
  );
}

// ============================================================
// DATA I/O
// ============================================================
function loadFigureData(slug) {
  const p = path.join(DATA_DIR, `${slug}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}

function saveFigureData(slug, data) {
  fs.writeFileSync(path.join(DATA_DIR, `${slug}.json`), JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================================
// GIT
// ============================================================
function gitCommit(msg) {
  try {
    execSync('git config user.name "RCI Scraper"', { timeout: 30000 });
    execSync('git config user.email "scraper@rci.bot"', { timeout: 30000 });
    execSync('git add -A', { timeout: 30000 });
    execSync(`git commit -m "${msg}" --allow-empty`, { timeout: 30000 });
  } catch (err) {
    console.error(`  [Git] commit failed: ${err.message.split('\n')[0]}`);
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execSync('git push', { timeout: 60000 });
      console.log(`  [Git] ${msg}`);
      return;
    } catch (err) {
      console.error(`  [Git] push attempt ${attempt}/3 failed: ${err.message.split('\n')[0]}`);
      if (attempt < 3) execSync('sleep 10');
    }
  }
  console.error('  [Git] all push attempts failed — data saved locally but not committed');
}

// ============================================================
// NORMALIZE: ensure all entries have sources array (handle legacy format)
// ============================================================
function normalizeEntry(entry) {
  if (entry.sources && Array.isArray(entry.sources)) return entry;
  // Legacy: single source/url → convert to sources array
  const sources = [];
  if (entry.url) {
    sources.push({ name: entry.source || 'Unknown', url: entry.url });
  }
  return {
    id: entry.id,
    date: entry.date,
    fact: entry.fact,
    sources,
  };
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('=== RepubliChud Index Scraper v3 ===\n');

  if (!GROQ_API_KEY) { console.error('ERROR: GROQ_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const figures = JSON.parse(fs.readFileSync(FIGURES_PATH, 'utf-8'));
  console.log(`Loaded ${figures.length} figures\n`);
  for (const fig of figures) FIGURE_SLUGS[fig.name] = fig.slug;

  let totalNew = 0;

  for (const fig of figures) {
    console.log(`\n========================================`);
    console.log(`  ${fig.name} (${fig.slug})`);
    console.log(`========================================`);

    const existing = loadFigureData(fig.slug);
    let existingEntries = (existing?.entries || []).map(normalizeEntry);
    const isInitialized = existing?.initialized === true;

    // ---- STEP 1: Wikipedia init (if not initialized) ----
    let wikiEntries = [];
    if (!isInitialized && fig.wikipedia && fig.wikipedia.length > 0) {
      console.log('\n  [STEP 1] Wikipedia initialization...');
      wikiEntries = await extractFromWikipedia(fig.wikipedia, fig.name, fig.slug);
      console.log(`    → ${wikiEntries.length} raw entries from Wikipedia`);

      if (wikiEntries.length > 0) {
        console.log('    Consolidating Wikipedia entries...');
        wikiEntries = await consolidateEntries(wikiEntries);
        console.log(`    → ${wikiEntries.length} after consolidation`);
      }
    } else if (isInitialized) {
      console.log('\n  [STEP 1] Already initialized, skipping Wikipedia');
    }

    // ---- STEP 2: Ongoing sources ----
    console.log('\n  [STEP 2] Ongoing sources...');

    console.log('  Fetching GDELT...');
    const gdelt = await fetchGdelt(fig.name, !isInitialized);
    console.log(`    → ${gdelt.length} articles`);

    console.log('  Fetching CourtListener...');
    const court = await fetchCourtListener(fig.name);
    console.log(`    → ${court.length} results`);

    console.log('  Fetching Congress.gov...');
    const congress = await fetchCongress(fig.name);
    console.log(`    → ${congress.length} results`);

    console.log('  Fetching RSS...');
    const rss = await fetchRssForFigure(fig.name);
    console.log(`    → ${rss.length} articles`);

    const allArticles = [...gdelt, ...court, ...congress, ...rss];
    console.log(`  Total: ${allArticles.length} raw sources`);

    let ongoingEntries = [];
    let failedBatches = 0;
    let totalBatches = 0;

    if (allArticles.length > 0) {
      console.log('\n  [STEP 2b] Extracting from articles...');
      const result = await extractFromArticles(allArticles);
      // Filter to this figure only
      ongoingEntries = result.entries
        .filter(e => e.figure === fig.slug)
        .map(e => ({ date: e.date, fact: e.fact, sources: e.sources }));
      failedBatches = result.failedBatches;
      totalBatches = result.totalBatches;
      console.log(`    → ${ongoingEntries.length} entries for ${fig.slug}, ${failedBatches}/${totalBatches} failed`);
    }

    // ---- STEP 3: Within-batch consolidation ----
    let newEntries = [...wikiEntries, ...ongoingEntries];

    if (newEntries.length > 1) {
      console.log(`\n  [STEP 3] Consolidating ${newEntries.length} new entries...`);
      newEntries = await consolidateEntries(newEntries);
      console.log(`    → ${newEntries.length} after consolidation`);
    }

    // ---- STEP 4: 5-day window consolidation ----
    // Skip during initialization: Wikipedia entries span decades, not 5 days.
    // Sending 700+ entries through a prompt designed for ~15 causes hallucinated merges.
    // String dedup (Step 5) is the correct safety net for initialization runs.
    if (newEntries.length > 0 && existingEntries.length > 0 && wikiEntries.length === 0) {
      console.log(`\n  [STEP 4] 5-day window consolidation...`);
      newEntries = await consolidateAgainstRecent(newEntries, existingEntries);
      console.log(`    → ${newEntries.length} genuinely new entries`);
    } else if (wikiEntries.length > 0) {
      console.log(`\n  [STEP 4] Skipping 5-day consolidation (initialization run)`);
    }

    // ---- STEP 5: String dedup ----
    if (newEntries.length > 0) {
      console.log(`\n  [STEP 5] String dedup...`);
      newEntries = stringDedup(existingEntries, newEntries);
      console.log(`    → ${newEntries.length} after string dedup`);
    }

    // ---- STEP 6: Save + commit ----
    const maxId = existingEntries.reduce((max, e) => Math.max(max, e.id || 0), 0);
    const withIds = newEntries.map((e, i) => ({ id: maxId + 1 + i, ...e }));
    const allEntries = [...existingEntries, ...withIds];

    // Determine initialization status
    // Only consider wiki "worked" if entries actually survived the full pipeline
    const wikiWorked = (fig.wikipedia || []).length === 0 || (wikiEntries.length > 0 && newEntries.length > 0);
    const ongoingWorked = totalBatches === 0 || failedBatches === 0;
    const sweepComplete = !isInitialized && wikiWorked && ongoingWorked;
    const markInitialized = (sweepComplete) || isInitialized;

    const data = {
      name: fig.name,
      slug: fig.slug,
      summary: existing?.summary || '',
      initialized: markInitialized,
      entries: allEntries,
    };

    if (sweepComplete && !isInitialized) {
      console.log('\n  ✓ Sweep complete — marking initialized');
    } else if (!isInitialized && !sweepComplete) {
      console.log(`\n  ✗ Sweep incomplete — will retry full sweep next run`);
    }

    // Generate summary
    if (allEntries.length > 0 && (newEntries.length > 0 || !existing?.summary)) {
      console.log('  Generating summary...');
      try {
        const summary = await generateSummary(allEntries, fig.name);
        if (summary) { data.summary = summary; console.log('    → Done'); }
      } catch (err) {
        console.error(`    → Failed: ${err.message.split('\n')[0].slice(0, 80)}`);
      }
    }

    saveFigureData(fig.slug, data);
    totalNew += newEntries.length;

    // Per-figure commit
    if (newEntries.length > 0 || !isInitialized) {
      gitCommit(`scraper: ${fig.slug} +${newEntries.length} entries [${new Date().toISOString()}]`);
    }

    console.log(`\n  → ${fig.name}: +${newEntries.length} new entries (${allEntries.length} total)`);
  }

  console.log(`\n=== Done. ${totalNew} new entries total. ===`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
