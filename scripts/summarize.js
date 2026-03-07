/**
 * RepubliChud Index — Summary Generator (standalone)
 * Usage: node summarize.js <slug>
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const DATA_DIR = path.join(__dirname, '..', 'data');
const RETRY_TIMEOUT_MS = 120_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let r = ''; res.on('data', c => r += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(r);
        else reject(new Error(`HTTP ${res.statusCode}: ${r.slice(0, 500)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

async function withRetry(fn) {
  const deadline = Date.now() + RETRY_TIMEOUT_MS;
  while (true) {
    try { return await fn(); }
    catch (err) {
      if (!err.message.includes('429') || Date.now() >= deadline) throw err;
      const m = err.message.match(/try again in ([\d.]+)s/);
      let wait = m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : 5000;
      const remaining = deadline - Date.now();
      if (wait > remaining) wait = remaining;
      console.log(`  Retrying in ${(wait / 1000).toFixed(1)}s...`);
      await sleep(wait);
    }
  }
}

async function generateSummary(entries, figureName) {
  const entriesText = entries.slice(0, 100).map(e => `- [${e.date}] ${e.fact}`).join('\n');
  const raw = await withRetry(() => httpPost(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: `You are writing a character summary for a political accountability database.\n\nBased only on these documented entries, write 3-5 sentences about ${figureName}'s character and pattern of behavior. Be direct and fierce. State what the facts show. Do not editorialize beyond what the entries support. Do not use hedging language.\n\nEntries:\n${entriesText}\n\nReturn only the summary text.` }],
      temperature: 0.3, max_tokens: 500,
    },
    { Authorization: `Bearer ${GROQ_API_KEY}` }
  ));
  const result = JSON.parse(raw);
  return result.choices?.[0]?.message?.content?.trim() || '';
}

const slug = process.argv[2];
if (!slug) { console.error('Usage: node summarize.js <slug>'); process.exit(1); }
if (!GROQ_API_KEY) { console.error('ERROR: GROQ_API_KEY not set'); process.exit(1); }
const filePath = path.join(DATA_DIR, `${slug}.json`);
if (!fs.existsSync(filePath)) { console.error(`No data for: ${slug}`); process.exit(1); }

const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
generateSummary(data.entries, data.name)
  .then(summary => {
    data.summary = summary;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`Updated summary for ${data.name}:\n${summary}`);
  })
  .catch(err => { console.error('Error:', err.message); process.exit(1); });
