/**
 * RepubliChud Index — Scraper
 *
 * Sources (all used for both historical sweep and ongoing):
 *   - GDELT Project (news articles indexed globally)
 *   - CourtListener (federal court documents)
 *   - Congress.gov API (votes, bills, actions)
 *   - AP Politics RSS
 *   - Reuters Politics RSS
 *   - C-SPAN RSS
 *
 * Flow:
 *   1. Read figures.json
 *   2. For each figure: if no data file → historical sweep, else → recent scrape
 *   3. All raw articles/documents → Groq extraction
 *   4. Deduplicate against existing entries
 *   5. Append new entries to data/{slug}.json
 *   6. Regenerate summary via summarize.js
 *   7. Commit changes via git
 *
 * Environment:
 *   GROQ_API_KEY — required
 *   Runs in GitHub Actions (Node.js 20+)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// ============================================================
// CONFIG
// ============================================================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama3-70b-8192';
const DATA_DIR = path.join(__dirname, '..', 'data');
const FIGURES_PATH = path.join(__dirname, '..', 'figures.json');
const SUMMARIZE_PATH = path.join(__dirname, 'summarize.js');

// Rate limiting for Groq
const GROQ_DELAY_MS = 1500;

// ============================================================
// HTTP HELPERS
// ============================================================
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'RepubliChudIndex/1.0',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${url}\n${body.slice(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });
    req.end();
  });
}

function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => (responseBody += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseBody);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${url}\n${responseBody.slice(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// XML/RSS PARSER (minimal, no dependencies)
// ============================================================
function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const description = extractTag(block, 'description');
    const pubDate = extractTag(block, 'pubDate');
    items.push({ title, link, description, pubDate });
  }
  return items;
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = regex.exec(xml);
  if (!m) return '';
  return (m[1] || m[2] || '').trim();
}

// ============================================================
// SOURCE: GDELT
// ============================================================
async function fetchGdelt(figureName, historical = false) {
  const articles = [];
  const query = encodeURIComponent(`"${figureName}"`);
  const mode = historical ? 'artlist' : 'artlist';
  // GDELT DOC API: max 250 articles per request
  const timespan = historical ? '' : '&timespan=6h';
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}+sourcelang:english&mode=${mode}&maxrecords=250&format=json${timespan}`;

  try {
    const raw = await httpGet(url);
    const data = JSON.parse(raw);
    if (data.articles) {
      for (const art of data.articles) {
        articles.push({
          title: art.title || '',
          url: art.url || '',
          source: art.domain || art.source || 'GDELT',
          date: art.seendate ? art.seendate.slice(0, 8) : '',
          snippet: art.title || '',
        });
      }
    }
  } catch (err) {
    console.error(`  [GDELT] Error for ${figureName}: ${err.message}`);
  }

  return articles;
}

// ============================================================
// SOURCE: COURTLISTENER
// ============================================================
async function fetchCourtListener(figureName, historical = false) {
  const results = [];
  const query = encodeURIComponent(figureName);
  // CourtListener search API (free, no key needed for basic search)
  const url = `https://www.courtlistener.com/api/rest/v4/search/?q=${query}&type=o&format=json&order_by=dateFiled+desc&page_size=50`;

  try {
    const raw = await httpGet(url);
    const data = JSON.parse(raw);
    if (data.results) {
      for (const r of data.results) {
        results.push({
          title: r.caseName || r.case_name || '',
          url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : '',
          source: 'CourtListener',
          date: r.dateFiled || r.date_filed || '',
          snippet: r.snippet || r.caseName || r.case_name || '',
        });
      }
    }
  } catch (err) {
    console.error(`  [CourtListener] Error for ${figureName}: ${err.message}`);
  }

  return results;
}

// ============================================================
// SOURCE: CONGRESS.GOV
// ============================================================
async function fetchCongress(figureName, historical = false) {
  const results = [];
  const query = encodeURIComponent(figureName);
  const url = `https://api.congress.gov/v3/bill?query=${query}&limit=50&format=json&api_key=DEMO_KEY`;

  try {
    const raw = await httpGet(url);
    const data = JSON.parse(raw);
    if (data.bills) {
      for (const bill of data.bills) {
        results.push({
          title: bill.title || '',
          url: bill.url || `https://congress.gov/bill/${bill.congress}th-congress/${bill.type?.toLowerCase()}/${bill.number}`,
          source: 'Congress.gov',
          date: bill.latestAction?.actionDate || bill.updateDate || '',
          snippet: `${bill.title || ''} — ${bill.latestAction?.text || ''}`,
        });
      }
    }
  } catch (err) {
    console.error(`  [Congress] Error for ${figureName}: ${err.message}`);
  }

  return results;
}

// ============================================================
// SOURCE: RSS FEEDS (AP, Reuters, C-SPAN)
// ============================================================
const RSS_FEEDS = [
  { name: 'AP Politics', url: 'https://rsshub.app/apnews/topics/politics' },
  { name: 'Reuters Politics', url: 'https://rsshub.app/reuters/world/us' },
  { name: 'C-SPAN', url: 'https://www.c-span.org/feeds/podcast' },
];

async function fetchRssForFigure(figureName) {
  const results = [];
  const nameLower = figureName.toLowerCase();
  // Also match last name
  const lastName = figureName.split(' ').pop().toLowerCase();

  for (const feed of RSS_FEEDS) {
    try {
      const xml = await httpGet(feed.url);
      const items = parseRssItems(xml);

      for (const item of items) {
        const text = `${item.title} ${item.description}`.toLowerCase();
        if (text.includes(nameLower) || text.includes(lastName)) {
          results.push({
            title: item.title,
            url: item.link,
            source: feed.name,
            date: item.pubDate ? new Date(item.pubDate).toISOString().slice(0, 10) : '',
            snippet: `${item.title}. ${item.description}`.slice(0, 500),
          });
        }
      }
    } catch (err) {
      console.error(`  [RSS/${feed.name}] Error: ${err.message}`);
    }
  }

  return results;
}

// ============================================================
// GROQ EXTRACTION
// ============================================================
const FIGURE_SLUGS = {}; // populated at runtime from figures.json

function buildFigureNameList() {
  return Object.entries(FIGURE_SLUGS)
    .map(([name, slug]) => name)
    .join(', ');
}

async function extractWithGroq(articles, figureSlugs) {
  const entries = [];

  // Batch articles into chunks to avoid overwhelming Groq
  const BATCH_SIZE = 5;

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const articlesText = batch
      .map((a, idx) => `[Article ${idx + 1}]\nTitle: ${a.title}\nSource: ${a.source}\nDate: ${a.date}\nURL: ${a.url}\nSnippet: ${a.snippet}`)
      .join('\n\n');

    const prompt = `You are extracting factual entries for a political accountability database.

Read these articles/documents. For each one that contains a clear, objective, documented negative action, quote, vote, or legal outcome for any of these figures:
${buildFigureNameList()}

Return a JSON array of entries. Each entry must be:
{
  "figure": "<slug>",
  "date": "YYYY-MM-DD",
  "fact": "one sentence, objective, specific, no editorializing",
  "source": "publication name",
  "url": "article URL"
}

Valid slugs: ${Object.values(figureSlugs).join(', ')}

If nothing relevant or clearly documented, return an empty array [].
Return ONLY valid JSON — no markdown, no explanation.

Articles:
${articlesText}`;

    try {
      const response = await httpPost(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: GROQ_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 4000,
        },
        {
          Authorization: `Bearer ${GROQ_API_KEY}`,
        }
      );

      const result = JSON.parse(response);
      const content = result.choices?.[0]?.message?.content?.trim();

      if (content) {
        // Try to parse JSON — handle potential markdown fences
        const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);

        if (Array.isArray(parsed)) {
          entries.push(...parsed.filter(e => e.figure && e.date && e.fact && e.url));
        } else if (parsed.figure) {
          entries.push(parsed);
        }
      }
    } catch (err) {
      console.error(`  [Groq] Extraction error: ${err.message}`);
    }

    await sleep(GROQ_DELAY_MS);
  }

  return entries;
}

// ============================================================
// DEDUPLICATION
// ============================================================
function deduplicateEntries(existing, newEntries) {
  const existingKeys = new Set(
    existing.map((e) => `${e.date}|${e.fact.toLowerCase().slice(0, 60)}`)
  );

  return newEntries.filter((e) => {
    const key = `${e.date}|${e.fact.toLowerCase().slice(0, 60)}`;
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });
}

// ============================================================
// DATA I/O
// ============================================================
function loadFigureData(slug) {
  const filePath = path.join(DATA_DIR, `${slug}.json`);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return null;
}

function saveFigureData(slug, data) {
  const filePath = path.join(DATA_DIR, `${slug}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function assignIds(entries, startId = 1) {
  return entries.map((e, i) => ({ id: startId + i, ...e }));
}

// ============================================================
// GIT HELPERS
// ============================================================
function gitCommit(message) {
  try {
    execSync('git config user.name "RCI Scraper"');
    execSync('git config user.email "scraper@republichu.dindex"');
    execSync('git add -A');
    execSync(`git commit -m "${message}" --allow-empty`);
    execSync('git push');
    console.log(`  [Git] Committed: ${message}`);
  } catch (err) {
    console.error(`  [Git] Commit error: ${err.message}`);
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('=== RepubliChud Index Scraper ===\n');

  if (!GROQ_API_KEY) {
    console.error('ERROR: GROQ_API_KEY not set');
    process.exit(1);
  }

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Load figures
  const figures = JSON.parse(fs.readFileSync(FIGURES_PATH, 'utf-8'));
  console.log(`Loaded ${figures.length} figures\n`);

  // Build slug lookup
  for (const fig of figures) {
    FIGURE_SLUGS[fig.name] = fig.slug;
  }

  let totalNewEntries = 0;

  for (const fig of figures) {
    console.log(`\n--- ${fig.name} (${fig.slug}) ---`);

    const existing = loadFigureData(fig.slug);
    const isHistorical = !existing;

    if (isHistorical) {
      console.log('  Mode: HISTORICAL SWEEP (first run)');
    } else {
      console.log(`  Mode: ONGOING (${existing.entries?.length || 0} existing entries)`);
    }

    // Collect from all sources
    console.log('  Fetching GDELT...');
    const gdeltArticles = await fetchGdelt(fig.name, isHistorical);
    console.log(`    → ${gdeltArticles.length} articles`);

    console.log('  Fetching CourtListener...');
    const courtArticles = await fetchCourtListener(fig.name, isHistorical);
    console.log(`    → ${courtArticles.length} results`);

    console.log('  Fetching Congress.gov...');
    const congressArticles = await fetchCongress(fig.name, isHistorical);
    console.log(`    → ${congressArticles.length} results`);

    console.log('  Fetching RSS feeds...');
    const rssArticles = await fetchRssForFigure(fig.name);
    console.log(`    → ${rssArticles.length} articles`);

    const allArticles = [...gdeltArticles, ...courtArticles, ...congressArticles, ...rssArticles];
    console.log(`  Total raw sources: ${allArticles.length}`);

    if (allArticles.length === 0) {
      console.log('  No articles found, skipping extraction');
      // Still create empty data file if it doesn't exist
      if (!existing) {
        saveFigureData(fig.slug, {
          name: fig.name,
          slug: fig.slug,
          summary: '',
          entries: [],
        });
      }
      continue;
    }

    // Extract via Groq
    console.log('  Extracting entries via Groq...');
    const extracted = await extractWithGroq(allArticles, FIGURE_SLUGS);
    console.log(`    → ${extracted.length} entries extracted`);

    // Filter to this figure only
    const figureEntries = extracted.filter((e) => e.figure === fig.slug);

    // Deduplicate
    const existingEntries = existing?.entries || [];
    const newEntries = deduplicateEntries(existingEntries, figureEntries);
    console.log(`    → ${newEntries.length} new (after dedup)`);

    if (newEntries.length > 0 || !existing) {
      const maxId = existingEntries.reduce((max, e) => Math.max(max, e.id || 0), 0);
      const withIds = assignIds(newEntries, maxId + 1);
      const allEntries = [...existingEntries, ...withIds];

      const data = {
        name: fig.name,
        slug: fig.slug,
        summary: existing?.summary || '',
        entries: allEntries,
      };

      saveFigureData(fig.slug, data);
      totalNewEntries += newEntries.length;

      // Regenerate summary
      if (allEntries.length > 0) {
        console.log('  Regenerating summary...');
        try {
          const { generateSummary } = require('./summarize.js');
          const summary = await generateSummary(allEntries, fig.name);
          if (summary) {
            data.summary = summary;
            saveFigureData(fig.slug, data);
            console.log('    → Summary updated');
          }
        } catch (err) {
          console.error(`    → Summary error: ${err.message}`);
        }
      }
    }

    // Small delay between figures
    await sleep(2000);
  }

  // Commit if anything changed
  if (totalNewEntries > 0) {
    console.log(`\n=== Committing ${totalNewEntries} new entries ===`);
    gitCommit(`scraper: +${totalNewEntries} entries [${new Date().toISOString()}]`);
  } else {
    console.log('\nNo new entries. Nothing to commit.');
    // Still commit data files for newly initialized figures
    try {
      const status = execSync('git status --porcelain').toString().trim();
      if (status) {
        gitCommit(`scraper: initialize new figures [${new Date().toISOString()}]`);
      }
    } catch {}
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
