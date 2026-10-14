// Rebuild the static snapshot and put it on GitHub Pages in one step.
//
//   npm run publish
//
// Build, commit, push, then wait until Pages is actually serving the new bytes —
// a push is not a publication, and the gap is a minute or two.

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = 'https://phoebefu6.github.io/public-speaking-partner/';

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const say = (s) => console.log(s);

// 1. Build. Inherit stdio so the generator's own report (and its leak check) is visible.
const build = spawnSync(process.execPath, ['--env-file=.env', 'scripts/build-site.js'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (build.status !== 0) {
  console.error('\nBuild failed — nothing published.');
  process.exit(build.status ?? 1);
}

// 2. Commit, unless the rebuild changed nothing. An unchanged vault reproduces a different
//    ciphertext every time (fresh salt and IV), so compare the plaintext inputs instead:
//    if git sees no change outside docs/, and docs/ differs only in its encryption, skip.
git('add', '-A');
const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
const nonDocs = staged.filter((f) => !f.startsWith('docs/'));

if (!staged.length) {
  say('\nNothing changed — the published site is already current.');
  process.exit(0);
}

if (!nonDocs.length) {
  // Only the payload moved. Decide by its decrypted contents, not its bytes.
  const previous = (() => {
    try {
      return git('show', 'HEAD:docs/payload.json');
    } catch {
      return null;
    }
  })();
  const passphrase = (process.env.SITE_PASSPHRASE || '').trim()
    || (fs.existsSync(path.join(ROOT, '.site-passphrase'))
      ? fs.readFileSync(path.join(ROOT, '.site-passphrase'), 'utf8').trim()
      : '');

  const open = (json) => {
    if (!json || !passphrase) return null;
    try {
      const sealed = JSON.parse(json);
      const key = crypto.pbkdf2Sync(passphrase, Buffer.from(sealed.kdf.salt, 'base64'),
        sealed.kdf.iterations, 32, 'sha256');
      const raw = Buffer.from(sealed.data, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  };

  const before = open(previous);
  const after = open(fs.readFileSync(path.join(ROOT, 'docs/payload.json'), 'utf8'));
  // `generated` is a timestamp and always differs; ignore it when comparing.
  const strip = (s) => (s ? s.replace(/"generated":"[^"]*",?/, '') : s);

  if (before && after && strip(before) === strip(after)) {
    git('checkout', '--', 'docs');
    say('\nNothing changed — the published site is already current.');
    say('(The payload re-encrypts differently every build; its contents are identical.)');
    process.exit(0);
  }
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
git('commit', '-m', `Rebuild the published site — ${stamp}\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`);
say(`\ncommitted: ${git('log', '--oneline', '-1')}`);

// 3. Push.
git('push');
say('pushed to origin/main');

// 4. Wait for Pages to serve the new bytes.
const local = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'docs/payload.json'))).digest('hex');
process.stdout.write('waiting for GitHub Pages');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let live = false;
for (let i = 0; i < 24; i++) {
  process.stdout.write('.');
  sleep(10_000);
  try {
    const res = await fetch(`${SITE}payload.json?cb=${Date.now()}`, { cache: 'no-store' });
    const body = Buffer.from(await res.arrayBuffer());
    if (crypto.createHash('sha256').update(body).digest('hex') === local) {
      live = true;
      break;
    }
  } catch {
    // Pages is mid-deploy; keep waiting.
  }
}

say('');
say(live
  ? `live — ${SITE}`
  : `pushed, but Pages has not served the new build yet. It usually lands within a few minutes: ${SITE}`);
