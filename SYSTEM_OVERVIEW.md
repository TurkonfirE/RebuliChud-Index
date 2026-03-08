# RepubliChud Index — System Overview

## What This Is

A static GitHub Pages site that tracks documented negative actions by Republican political figures. Users click a portrait, see a chronological list of sourced entries (date, one-sentence fact, source links), and an AI-generated character summary at the top.

## Architecture

Zero backend. Plain HTML/CSS/JS + JSON data files. GitHub Actions scraper runs every 6 hours.

### Data Format (per figure: `data/{slug}.json`)

```json
{
  "name": "Donald Trump",
  "slug": "trump",
  "summary": "AI-generated 3-5 sentence summary...",
  "initialized": true,
  "entries": [
    {
      "id": 1,
      "date": "2023-05-09",
      "fact": "Found liable for sexual abuse by a Manhattan jury",
      "sources": [
        { "name": "New York Times", "url": "https://nytimes.com/..." },
        { "name": "AP News", "url": "https://apnews.com/..." }
      ]
    }
  ]
}
```

Entries have multiple sources when different outlets report the same event. Earliest date is used. Sources array replaces the old single `source`/`url` fields (legacy format still handled by renderer).

### Figure Config (`figures.json`)

```json
{
  "name": "Donald Trump",
  "slug": "trump",
  "photo": "images/trump.png",
  "wikipedia": ["Donald_Trump"]
}
```

Adding a new person: add photo + config entry + push. Scraper auto-initializes.

### Scraper Pipeline (`scripts/scraper.js`)

Six steps, executed per figure:

1. **Wikipedia Init (once):** Fetch article HTML via Wikipedia Parse API → strip to text with reference markers → chunk into ~5000 char pieces → send each chunk to Groq with reference URL map → extract structured entries. Only runs when `initialized !== true`.

2. **Ongoing Sources (every run):** GDELT (news), CourtListener (court docs), Congress.gov (bills/votes), RSS (AP, NPR, PBS, The Hill) → Groq extracts structured entries from article batches of 3.

3. **Within-Batch Consolidation:** Groq merges duplicate events from the same run into single entries with combined sources arrays. Processes in chunks of 30 entries.

4. **5-Day Window Consolidation:** Groq compares new entries against existing entries from the last 5 days. Merges semantically identical events, adds new source links to existing entries.

5. **String Dedup:** Free safety net. Compares `date + first 60 chars of fact` against ALL existing entries. Instant Set lookup.

6. **Per-Figure Git Commit:** Saves data file and pushes after each figure so work isn't lost on timeout.

### Rate Limiting

- **RateLimiter class:** Enforces per-source minimum delays (Groq: 6s, GDELT: 6s, etc.)
- **withRetry function:** On 429 errors, parses Groq's "try again in Xs" message and waits. Times out after 120s (2× Groq's 60s rate limit window). Non-429 errors fail immediately.

### LLM

Groq API with `llama-3.3-70b-versatile`. Dev tier ($5 credit loaded). Pricing: $0.59/M input tokens, $0.79/M output tokens.

### Frontend

- `index.html` — Search bar + portrait scroll (alphabetical)
- `profile.html` — Figure name, AI summary, chronological entry list (newest first). Each entry: date left, fact center, source links right (multiple links separated by `·`)
- `style.css` — Light mode only, red accent for "Reprehensible Activity" label, mobile-first

### GitHub

- Repo: `TurkonfirE/RebuliChud-Index`
- Pages enabled on `main` branch
- Secrets: `GROQ_API_KEY`
- Workflow: `.github/workflows/scraper.yml` (6-hour cron + manual dispatch, 60-min timeout)
- Workflow permissions: Read and write
