// Build a static, password-locked snapshot of the vault for GitHub Pages.
//
// GitHub serves the result publicly — a private repo does not give you a private
// site — so nothing readable may leave this script. The whole vault is packed into
// one JSON payload, encrypted with AES-256-GCM under a key derived from a passphrase,
// and only the ciphertext is written. The shell page decrypts it in the browser.
//
//   npm run build-site            # uses (or creates) .site-passphrase
//   SITE_PASSPHRASE=… npm run build-site
//
// The site is read-only by design: ingesting, word lookups, the Polish pass and the
// Notion sync all need the server and stay local.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { allTalks, allWords, findTalkById, parseTalkNote } from '../lib/library.js';
import { allPhrases, CATEGORIES } from '../lib/collections.js';
import { DIRS, listNotes, readNote, VAULT } from '../lib/vault.js';
import { displayName, knownLabels, speakerLabel } from '../public/labels.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'docs');
const SHELL = path.join(ROOT, 'scripts', 'site-shell.html');
const PASSPHRASE_FILE = path.join(ROOT, '.site-passphrase');

// PBKDF2 cost. The ciphertext is public, so the passphrase is the only thing between a
// downloader and the text — make each guess expensive. Browsers handle this in ~1s.
const ITERATIONS = 600_000;

// ------------------------------------------------------------------ markdown

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Enough markdown for the vault's own notes — headings, lists, quotes, emphasis, links. */
function markdown(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let list = null;

  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">$1</span>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/&lt;sup&gt;(.*?)&lt;\/sup&gt;/g, '<sup>$1</sup>');

  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);

    if (!line.trim()) {
      closeList();
      continue;
    }
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (bullet) {
      const indented = bullet[1].length > 0;
      if (!list) {
        list = 'ul';
        out.push('<ul>');
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(bullet[2]);
      const text = task ? task[2] : bullet[2];
      const box = task ? `<span class="box">${task[1].trim() ? '☑' : '☐'}</span> ` : '';
      out.push(`<li class="${indented ? 'sub' : ''}">${box}${inline(text)}</li>`);
      continue;
    }
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

/** A note's body minus the named `## ` sections. Split rather than regex: the obvious
 *  pattern needs an end-of-input anchor, and JavaScript has no \Z, so the last section
 *  would silently survive — which once dropped a whole transcript into the craft note. */
function bodyWithout(body, drop = []) {
  if (!drop.length) return body;
  const unwanted = new Set(drop);
  const parts = String(body).split(/^## [ \t]*/m);
  const kept = [parts[0]];
  for (const part of parts.slice(1)) {
    const title = part.split('\n', 1)[0].trim();
    if (!unwanted.has(title)) kept.push(`## ${part}`);
  }
  return kept.join('').trim();
}

// ------------------------------------------------------------------ collect

function collectTalks() {
  return allTalks()
    .map((t) => {
      const note = findTalkById(t.id);
      if (!note) return null;
      const parsed = parseTalkNote(note);
      const labels = knownLabels(parsed.paragraphs);

      // In a two-hander `speaker` is both names joined, so resolve each paragraph's own
      // speaker from the turn markers — the same derivation the live reader uses.
      const speakers = parsed.paragraphs.map((para) => {
        const turn = speakerLabel(para, labels);
        return turn ? displayName(turn.who, labels) : labels.size ? '' : t.speaker || '';
      });

      return {
        id: t.id,
        title: t.title || '',
        speaker: t.speaker || '',
        source: t.source || '',
        url: t.url || '',
        date: t.date || '',
        duration: t.duration || 0,
        words: t.words || 0,
        difficulty: t.difficulty || '',
        topics: Array.isArray(t.topics) ? t.topics : [],
        status: t.status || '',
        paragraphs: parsed.paragraphs,
        reviewed: parsed.reviewed,
        corrections: parsed.corrections || [],
        languageNotes: markdown(parsed.languageNotes || ''),
        speakers,
        craft: markdown(
          bodyWithout(note.body, [
            'Transcript',
            'Transcript (reviewed)',
            'Corrections',
            'Language notes',
            'Cues',
            'Words from this talk',
          ]),
        ),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function collectWords() {
  const meta = Object.fromEntries(allWords().map((w) => [w.word, w]));
  return listNotes(DIRS.vocab)
    .map((abs) => readNote(abs))
    .filter((n) => n?.frontmatter?.type === 'vocab')
    .map((n) => {
      const f = n.frontmatter;
      return {
        word: f.word,
        ipa: f.ipa || f.ipa_uk || f.ipa_us || '',
        zh: f.zh || '',
        band: f.band || '',
        pos: f.pos || '',
        examTags: Array.isArray(f.exam_tags) ? f.exam_tags : [],
        status: f.status || 'new',
        talk: f.talk || '',
        talkTitle: f.talk_title || meta[f.word]?.talk_title || '',
        context: f.context || '',
        audio: f.audio_uk || f.audio_us || '',
        body: markdown(n.body),
      };
    })
    .sort((a, b) => String(a.word).localeCompare(String(b.word)));
}

function collectPhrases() {
  const bodies = Object.fromEntries(
    listNotes(DIRS.phrases)
      .map((abs) => readNote(abs))
      .filter((n) => n?.frontmatter?.type === 'phrase')
      .map((n) => [n.frontmatter.id, n.body]),
  );
  return allPhrases().map((p) => ({
    id: p.id,
    category: p.category || '',
    categoryLabel: CATEGORIES[p.category] || p.category || '',
    text: p.text || '',
    talk: p.talk || '',
    talkTitle: p.talk_title || '',
    speaker: p.speaker || '',
    source: p.source || '',
    reciteStatus: p.recite_status || 'new',
    timesRecited: p.times_recited || 0,
    // The note opens by quoting the line and carries a Category section; both are already
    // on the card, so strip them rather than printing the phrase twice.
    body: markdown(
      bodyWithout(bodies[p.id] || '', ['Recite it', 'Category']).replace(/^(?:>.*\n?)+/, '').trim(),
    ),
  }));
}

function collectFolder(dir) {
  if (!dir || !fs.existsSync(path.join(VAULT, dir))) return [];
  return listNotes(dir)
    .map((abs) => readNote(abs))
    .filter(Boolean)
    .map((n) => ({
      title: path.basename(n.path).replace(/\.md$/, ''),
      body: markdown(n.body),
    }));
}

// ------------------------------------------------------------------ crypto

function encrypt(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    // WebCrypto expects the GCM tag appended to the ciphertext.
    data: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
  };
}

function resolvePassphrase() {
  const fromEnv = (process.env.SITE_PASSPHRASE || '').trim();
  if (fromEnv) return { passphrase: fromEnv, source: 'SITE_PASSPHRASE' };

  if (fs.existsSync(PASSPHRASE_FILE)) {
    const saved = fs.readFileSync(PASSPHRASE_FILE, 'utf8').trim();
    if (saved) return { passphrase: saved, source: '.site-passphrase' };
  }

  // Never invent a weak one and never print it into a transcript: four words from a
  // wordlist, written to a gitignored file she can read, change, or replace.
  const words = 'anchor,ballast,cadence,driftwood,ember,fathom,granite,harbour,ivory,juniper,kindle,lantern,meadow,nocturne,orchard,pewter,quarry,rampart,saffron,tundra,umber,verdant,willow,zephyr'.split(',');
  const pick = () => words[crypto.randomInt(words.length)];
  const passphrase = [pick(), pick(), pick(), pick()].join('-');
  fs.writeFileSync(PASSPHRASE_FILE, `${passphrase}\n`, { mode: 0o600 });
  return { passphrase, source: 'generated', created: true };
}

// ------------------------------------------------------------------ build

const { passphrase, source, created } = resolvePassphrase();

const payload = {
  generated: new Date().toISOString(),
  talks: collectTalks(),
  words: collectWords(),
  phrases: collectPhrases(),
  craft: collectFolder(DIRS.craft),
  coaching: collectFolder(DIRS.coaching),
};

const plaintext = JSON.stringify(payload);
const sealed = encrypt(plaintext, passphrase);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'payload.json'), JSON.stringify(sealed));
fs.writeFileSync(path.join(OUT, 'index.html'), fs.readFileSync(SHELL, 'utf8'));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// A leak here is published to the open web, so prove it rather than assume it: take real
// sentences out of the payload and confirm none of them survive anywhere in the output.
const probes = [
  payload.talks[0]?.paragraphs?.find((p) => p.length > 40),
  payload.talks.at(-1)?.paragraphs?.find((p) => p.length > 40),
  payload.phrases[0]?.text,
  payload.words[0]?.context,
].filter(Boolean);

const written = fs.readdirSync(OUT).map((f) => ({ f, text: fs.readFileSync(path.join(OUT, f), 'utf8') }));
for (const probe of probes) {
  const needle = probe.slice(0, 48);
  for (const { f, text } of written) {
    if (text.includes(needle)) {
      fs.rmSync(OUT, { recursive: true, force: true });
      throw new Error(`Plaintext leaked into docs/${f} — output deleted. Probe: ${needle}`);
    }
  }
}

const bytes = fs.statSync(path.join(OUT, 'payload.json')).size;
console.log(
  [
    `docs/ built — ${payload.talks.length} talks, ${payload.words.length} words, ` +
      `${payload.phrases.length} phrases, ${payload.craft.length} craft notes`,
    `payload: ${(bytes / 1024).toFixed(0)} KB encrypted (AES-256-GCM, PBKDF2 ${ITERATIONS.toLocaleString()})`,
    `checked ${probes.length} plaintext probes — none present in the output`,
    `passphrase: ${source}${created ? ' — written to .site-passphrase (gitignored)' : ''}`,
  ].join('\n'),
);
