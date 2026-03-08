# RepubliChud Index — Current Issues & Required Fixes

## Issue 1: 5-Day Consolidation Destroys Wikipedia Entries (CRITICAL)

### What Happened
Run #4 extracted 706 Wikipedia entries for Trump, consolidated to 677, added 102 ongoing entries, consolidated within-batch to 764 total. Then `consolidateAgainstRecent` (Step 4) compared all 764 new entries against 39 existing entries from the last 5 days.

Result: **"→ 0 genuinely new entries"**. All 764 entries silently lost. Trump kept only his original 39 entries.

### Root Cause
`consolidateAgainstRecent()` sends ALL new entries in a single Groq prompt:

```javascript
const prompt = `...
EXISTING entries (last 5 days):
${JSON.stringify(recentExisting.map(e => ({ date: e.date, fact: e.fact })))}

NEW entries to check:
${JSON.stringify(newEntries)}  // ← 764 entries in one prompt
...`;
```

764 entries is far too many tokens for one prompt. Groq couldn't reason coherently and hallucinated — it marked every single entry as "merge with existing" even though there are only 39 existing entries. The function returned `toInsert = []` (0 genuinely new entries).

Since the pipeline is sequential (Step 4 output feeds Step 5), string dedup received 0 entries and had nothing to process. The final `allEntries` was just the original 39.

### Fix

**During initialization (Wikipedia entries present): skip Step 4 entirely.** Wikipedia entries span 1973-2026 — comparing them against 5 days of recent entries is nonsensical. String dedup (Step 5) is the correct safety net for initialization. It's free, instant, and runs against ALL entries.

**During ongoing scrapes: Step 4 works fine as-is.** Ongoing runs produce maybe 10-20 new entries compared against 30-50 recent existing entries. That fits comfortably in one Groq prompt. The problem was exclusively caused by 764 Wikipedia entries being forced through a path designed for 15.

### Implementation

In the main loop, after Step 3 (within-batch consolidation), add a condition:

```javascript
// Step 4: Only for ongoing scrapes, not initialization
if (newEntries.length > 0 && existingEntries.length > 0 && wikiEntries.length === 0) {
  // 5-day window consolidation
  newEntries = await consolidateAgainstRecent(newEntries, existingEntries);
}
```

This is one conditional. Not a redesign.

---

## Issue 2: Wikipedia Reference URLs Not Extracted (MEDIUM)

### What Happened
Every Wikipedia article shows "→ 0 references found". The reference parser (`extractReferencesFromHtml`) isn't matching Wikipedia's actual HTML structure.

### Root Cause
The regex looks for:
```javascript
/<li id="cite_note-([^"]*)"[^>]*>([\s\S]*?)<\/li>/g
```

Wikipedia's actual HTML likely uses a different structure for reference list items. The `id` format, nesting, or tag structure may not match. This needs to be debugged against the actual HTML returned by the Wikipedia Parse API.

### Impact
All Wikipedia entries fall back to `{"name": "Wikipedia", "url": "https://en.wikipedia.org/wiki/..."}` instead of real source URLs (NYT, AP, court records, etc.). The entries are still valuable (correct dates and facts), but the source links are weak.

### Debugging Steps

1. Fetch the actual HTML from Wikipedia's Parse API for a test article
2. Inspect the reference section HTML structure
3. Find the actual pattern for reference list items and their URLs
4. Update the regex in `extractReferencesFromHtml`
5. Also check: the `stripHtml` function preserves `[REF:id]` markers using a regex on `<sup class="reference">`. Verify this matches the actual HTML class names.

### How to Debug Locally

```bash
# Fetch Trump's Wikipedia HTML and save to file for inspection
curl "https://en.wikipedia.org/w/api.php?action=parse&page=Donald_Trump&prop=text&format=json" | node -e "
  const fs = require('fs');
  let data = '';
  process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => {
    const html = JSON.parse(data).parse.text['*'];
    fs.writeFileSync('wiki_test.html', html);
    console.log('Saved. Now search for cite_note patterns.');
  });
"
# Then grep for reference patterns:
grep -o 'id="cite_note[^"]*"' wiki_test.html | head -20
grep -o '<li id="cite[^>]*>' wiki_test.html | head -20
```

---

## Issue 3: The Hill RSS Returns 301 (LOW)

### What Happened
```
[RSS/The Hill] HTTP 301: https://thehill.com/feed/
```

The Hill changed their feed URL. The redirect isn't followed.

### Fix
Either update the URL to wherever the 301 redirects, or follow redirects in the `httpGet` function, or replace The Hill with a different source (e.g., ProPublica, Politico).

---

## Issue 4: Within-Batch Consolidation May Be Lossy (LOW)

### What Happened
Trump: 706 raw Wikipedia entries → 677 after consolidation (29 lost). Kirk: 243 → 226 (17 lost).

### Question
Are those 29/17 entries being correctly merged into other entries (with combined sources), or silently dropped? The consolidation processes in chunks of 30 — entries in chunk 1 can't be merged with entries in chunk 5. Cross-chunk duplicates may be dropped instead of merged.

### Potential Fix
Run consolidation in two passes: first pass in chunks of 30, second pass across the output. Or increase chunk size. Or rely on string dedup as the safety net and accept some duplicates in exchange for zero data loss.

---

## Priority Order

1. **Issue 1** — Fix immediately. This is the blocker. 764 entries are being silently destroyed.
2. **Issue 2** — Fix next. Wikipedia source URLs are the main value proposition.
3. **Issue 3** — Minor. Replace URL or add redirect following.
4. **Issue 4** — Monitor. May not matter in practice if duplicates are rare.

---

## Current State of Data

- Trump: 39 entries (all from GDELT/CourtListener run #2, NOT from Wikipedia)
- Kirk: Unknown (run cancelled during Kirk's ongoing source extraction)
- MTG, DeSantis, Vance: May have old data from run #2, no Wikipedia data
- Trump was marked `initialized: true` on run #4 (line 211) despite 0 new entries being saved — this is a secondary bug. The initialized flag should only be set when entries are actually written. On next run, Trump will be treated as "already initialized" and Wikipedia will be skipped.

### Implication
After fixing Issue 1, Trump's initialized flag needs to be manually reset to `false` in `data/trump.json` (or the entire data directory should be cleared) before re-running. Otherwise the scraper will skip Wikipedia for Trump since it's marked initialized.
