/**
 * RepubliChud Index — Summary Generator
 *
 * Generates a 3-5 sentence character summary based on documented entries.
 * Called by the scraper after new entries are added.
 *
 * Can also be run standalone:
 *   node summarize.js <slug>
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama3-70b-8192';
const DATA_DIR = path.join(__dirname, '..', 'data');

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
          reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Generate a summary from a list of entries.
 * Exported for use by scraper.js
 */
async function generateSummary(entries, figureName) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not set');
  }

  if (!entries || entries.length === 0) {
    return '';
  }

  // Format entries for the prompt
  const entriesText = entries
    .map((e) => `- [${e.date}] ${e.fact} (${e.source})`)
    .join('\n');

  const prompt = `You are writing a character summary for a political accountability database.

Based only on these documented entries, write 3-5 sentences about ${figureName}'s character and pattern of behavior. Be direct and fierce. State what the facts show. Do not editorialize beyond what the entries support. Do not use hedging language.

Entries:
${entriesText}

Write the summary now. Return only the summary text, nothing else.`;

  const response = await httpPost(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    },
    {
      Authorization: `Bearer ${GROQ_API_KEY}`,
    }
  );

  const result = JSON.parse(response);
  const content = result.choices?.[0]?.message?.content?.trim();
  return content || '';
}

module.exports = { generateSummary };

// ---- Standalone mode ----
if (require.main === module) {
  const slug = process.argv[2];

  if (!slug) {
    console.error('Usage: node summarize.js <slug>');
    process.exit(1);
  }

  const filePath = path.join(DATA_DIR, `${slug}.json`);
  if (!fs.existsSync(filePath)) {
    console.error(`No data file for slug: ${slug}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  generateSummary(data.entries, data.name)
    .then((summary) => {
      data.summary = summary;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`Summary updated for ${data.name}:`);
      console.log(summary);
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
