// Throw away the cache and rebuild it from the vault.
//
// This is the proof that ~/speech-vault is the source of truth: delete data/cache.db,
// run this, and the app is exactly where it was.
//
// If the server is running we ask IT to rebuild. Rebuilding from a separate process
// would leave the server holding a handle to the deleted database file, and it would
// happily keep serving stale rows.

import { rebuild } from '../lib/index-db.js';
import { VAULT } from '../lib/vault.js';

const PORT = Number(process.env.PORT) || 4321;
const started = Date.now();

async function viaServer() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(`http://localhost:${PORT}/api/resync`, { method: 'POST', signal: ctl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const remote = await viaServer();
const { talks, words } = remote ?? rebuild({ log: (m) => console.log(m) });

console.log(
  `rebuilt from ${VAULT} in ${Date.now() - started}ms → ${talks} talks, ${words} words` +
  (remote ? ' (via running server)' : '')
);
