// One-command Notion wiring.
//
//   node scripts/notion-setup.js ntn_xxxxxxxxxxxx
//
// Validates the token, checks the database is actually shared with the integration,
// writes .env, and runs the first full sync. Every failure says exactly what to fix.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV = path.join(HERE, '.env');
const DB_ID = '83525ffddae143a7b3324e360728953d';

const token = (process.argv[2] || '').trim();
if (!token) {
  console.error('usage: node scripts/notion-setup.js <NOTION_TOKEN>');
  console.error('Get one at https://www.notion.so/my-integrations → New integration');
  process.exit(1);
}

const api = (p, init) => fetch(`https://api.notion.com/v1${p}`, {
  ...init,
  headers: {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  },
});

// 1. Is the token itself valid?
const me = await api('/users/me');
if (!me.ok) {
  const body = await me.json().catch(() => ({}));
  console.error(`✗ Token rejected (HTTP ${me.status}): ${body.message || 'unknown error'}`);
  console.error('  Check you copied the whole secret, starting "ntn_" or "secret_".');
  process.exit(1);
}
console.log(`✓ Token valid — integration "${(await me.json()).name || 'unnamed'}"`);

// 2. Can it see the Speeches database? This is the step people forget.
const db = await api(`/databases/${DB_ID}`);
if (!db.ok) {
  console.error(`✗ Cannot reach the Speeches database (HTTP ${db.status}).`);
  console.error('  In Notion: open the Speeches database → ⋯ menu (top right) → Connections');
  console.error('  → add your integration. Then run this again.');
  process.exit(1);
}
const dbJson = await db.json();
console.log(`✓ Database reachable — "${dbJson.title?.[0]?.plain_text || 'Speeches'}"`);

// 3. Persist, preserving anything else already in .env.
let env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
env = env.replace(/^NOTION_TOKEN=.*$/m, `NOTION_TOKEN=${token}`);
if (!/^NOTION_TOKEN=/m.test(env)) env += `\nNOTION_TOKEN=${token}\n`;
env = env.replace(/^NOTION_DATABASE_ID=.*$/m, `NOTION_DATABASE_ID=${DB_ID}`);
if (!/^NOTION_DATABASE_ID=/m.test(env)) env += `NOTION_DATABASE_ID=${DB_ID}\n`;
fs.writeFileSync(ENV, env);
console.log('✓ Saved to .env (gitignored)');

// 4. First sync, so the transcript lands immediately.
process.env.NOTION_TOKEN = token;
process.env.NOTION_DATABASE_ID = DB_ID;
const { syncTalk } = await import('../lib/notion-sync.js');
const { allTalks } = await import('../lib/library.js');

const talks = allTalks();
console.log(`\nSyncing ${talks.length} talk${talks.length === 1 ? '' : 's'}…`);
for (const t of talks) {
  try {
    const r = await syncTalk(t.id);
    console.log(`  ✓ ${t.id} ${t.title.slice(0, 48)} — ${r.words} words, ${r.created ? 'created' : 'updated'}`);
  } catch (err) {
    console.error(`  ✗ ${t.id} — ${err.message}`);
  }
}
console.log('\nDone. Restart the server so live edits sync too:  npm start');
