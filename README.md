# RepubliChud Index

A static political accountability tracker. Documented. Sourced. Unedited.

Automatically scrapes court records, congressional records, and wire services to build a running list of documented actions for each figure.

## Setup

1. **Create a GitHub repo** and push this code
2. **Enable GitHub Pages** from Settings → Pages → Source: `main` branch, root `/`
3. **Get a free Groq API key** at [console.groq.com](https://console.groq.com)
4. **Add the secret**: Settings → Secrets → Actions → `GROQ_API_KEY`
5. **Add figure photos** to `/images/` (named `{slug}.jpg`)
6. **Trigger the first scrape**: Actions → "RCI Scraper" → "Run workflow"

## Adding a New Figure

1. Add their photo to `/images/{slug}.jpg`
2. Add an entry to `figures.json`:
   ```json
   {
     "name": "Full Name",
     "slug": "lastname",
     "photo": "images/lastname.jpg"
   }
   ```
3. Push. They appear in the scroll immediately. The next scraper run (or manual trigger) initializes their data automatically.

## Architecture

- **No backend, no database, no build step**
- Plain HTML/CSS/JS + JSON data files
- GitHub Actions scraper runs every 6 hours
- Groq (llama3-70b) extracts structured facts from primary sources
- All entries link to original source URLs

## Sources

- GDELT Project (global news index)
- CourtListener (federal court documents)
- Congress.gov (votes, bills, actions)
- AP Politics (RSS)
- Reuters Politics (RSS)
- C-SPAN (RSS)
