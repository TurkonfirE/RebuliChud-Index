/**
 * One-time data cleanup script.
 *
 * Removes:
 *  - Specific bad entries by figure+id (empathetic, victim, vague, biographical)
 *  - Entries with junk sources (attack sites, gossip blogs, content farms)
 *  - Entries with homepage-only source URLs
 *  - Entries with social media sources
 *  - Entries with all-"Unknown" sources
 *  - Entries where no valid sources remain after cleaning
 *
 * Run: node scripts/cleanup.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ── Specific entry IDs to remove outright ──────────────────────────────────
const REMOVE_BY_ID = {
  mtg: new Set([
    333,  // "Made shocking statements" — vague, no content
    334,  // "Christ-like pivot" — vague headline
    337,  // "Left Congress after five years" — biographical
    342,  // "A man pleaded guilty to threatening MTG" — she's the victim
    348,  // "Called servicemember deaths unnecessary" — empathetic statement
  ]),
  vance: new Set([
    36,   // Won Senate primary — neutral electoral fact
    38,   // Won Senate election — neutral electoral fact
    40,   // "Made statements criticized by Democrats" — zero specifics
    67,   // "Finds a kindred spirit with Trump" — just a headline
    87,   // Completely vague
    88,   // Vague; sourced from "Reality Tea"
  ]),
};

// ── Domains that should never appear as sources ────────────────────────────
const JUNK_DOMAINS = new Set([
  'article.wn.com', 'wn.com', '2paragraphs.com',
  'vancewreckingball.com', 'lynch.com',
  'realitytea.com', 'realitytea.net',
  'hiphopcwired.com', 'hiphopcwired.net', 'hiphopwired.com',
  'themarysue.com', 'meaww.com',
  'dailymail.co.uk',
  'rawstory.com', 'redstate.com', 'wonkette.com', 'alternet.org',
  'radaronline.com',
  'yahoo.com',
]);

const SOCIAL_DOMAINS = new Set([
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'youtube.com', 'reddit.com',
]);

// ── Junk source names (reporter names, attack sites, etc.) ─────────────────
const JUNK_NAMES = new Set([
  'unknown', 'zeleny', 'lynch', 'ting', 'twitter', 'facebook',
  'the water cooler', 'reality tea', 'radar online', 'hip hop wired', 'hiphopwired',
  'the mary sue', 'meaww', 'wonkette', 'alternet',
]);

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function isHomepageUrl(url) {
  try {
    const { pathname, search } = new URL(url);
    return (pathname === '/' || pathname === '') && !search;
  } catch { return true; }
}

function isValidSource(src) {
  if (!src || !src.url || !src.name) return false;
  const nameLower = src.name.toLowerCase().trim();
  if (JUNK_NAMES.has(nameLower)) return false;
  const domain = getDomain(src.url);
  if (!domain) return false;
  if (JUNK_DOMAINS.has(domain)) return false;
  if (SOCIAL_DOMAINS.has(domain)) return false;
  if (isHomepageUrl(src.url)) return false;
  return true;
}

function cleanEntry(entry, slug, removeSet) {
  // Remove by explicit ID list
  if (removeSet && removeSet.has(entry.id)) return null;

  // Clean sources
  const validSources = (entry.sources || []).filter(isValidSource);
  if (validSources.length === 0) return null;

  return { ...entry, sources: validSources };
}

function processFile(slug) {
  const filePath = path.join(DATA_DIR, `${slug}.json`);
  if (!fs.existsSync(filePath)) {
    console.log(`  [${slug}] file not found, skipping`);
    return;
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const original = data.entries || [];
  const removeSet = REMOVE_BY_ID[slug] || new Set();

  const cleaned = original.map(e => cleanEntry(e, slug, removeSet)).filter(Boolean);

  const removed = original.length - cleaned.length;
  console.log(`  [${slug}] ${original.length} → ${cleaned.length} entries (removed ${removed})`);

  if (removed > 0) {
    // Log what was removed
    const removedEntries = original.filter(e => !cleaned.find(c => c.id === e.id));
    for (const e of removedEntries) {
      const reason = removeSet.has(e.id) ? 'explicit-id' : 'bad-sources';
      console.log(`    - [${e.id}] ${reason}: ${e.fact?.slice(0, 80)}`);
    }
  }

  data.entries = cleaned;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

const slugs = fs.readdirSync(DATA_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''));

console.log('=== Data Cleanup ===\n');
for (const slug of slugs) {
  processFile(slug);
}
console.log('\nDone.');
