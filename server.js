// English Learning Partner — local HTTP server.
//
// Zero runtime dependencies: node:http, node:sqlite, and global fetch are all built in.
// The vault is the source of truth; data/cache.db is a derived index.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as idx from './lib/index-db.js';
import * as lib from './lib/library.js';
import * as review from './lib/review.js';
import { buildCard } from './lib/lookup.js';
import { ingestTed, isTedUrl } from './lib/ingest-ted.js';
import { ingestText, ingestYoutube, isYoutubeUrl } from './lib/ingest-other.js';
import { DIRS, VAULT, ensureVault, patchFrontmatter, readNote, vaultPath } from './lib/vault.js';
import { buildSheet } from './lib/sheet.js';
import { lemmatize as dictLemmatize } from './lib/dict.js';
import * as notion from './lib/notion-sync.js';
import * as polish from './lib/polish.js';
import * as topics from './lib/topics.js';
import { displayName, knownLabels, speakerLabel } from './public/labels.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.PORT) || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
};
const ok = (res, body) => send(res, 200, body);
const fail = (res, code, message) => send(res, code, { error: message });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const abs = path.join(PUBLIC, rel);
  if (!abs.startsWith(PUBLIC) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return false;
  send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs)] || 'application/octet-stream');
  return true;
}

// ------------------------------------------------------------------ ingest

async function resolveSource(body) {
  const url = String(body.url || '').trim();
  if (body.text) return ingestText(body);
  if (!url) throw new Error('Give me a URL or some text');
  if (isTedUrl(url)) return ingestTed(url);
  if (isYoutubeUrl(url)) return ingestYoutube(url);
  throw new Error('Only TED and YouTube links are supported so far — paste the transcript text instead');
}

// ------------------------------------------------------------------- routes

const routes = {
  'GET /api/health': async (_req, res) => ok(res, { ok: true, vault: VAULT }),

  'GET /api/stats': async (_req, res) => ok(res, review.stats()),

  'GET /api/facets': async (_req, res) => ok(res, idx.facets()),

  'GET /api/talks': async (_req, res, url) => {
    const p = url.searchParams;
    ok(res, idx.searchTalks({
      q: p.get('q') || '',
      source: p.get('source') || undefined,
      difficulty: p.get('difficulty') || undefined,
      status: p.get('status') || undefined,
      topic: p.get('topic') || undefined,
      limit: Math.min(Number(p.get('limit')) || 40, 100),
      offset: Number(p.get('offset')) || 0,
    }));
  },

  'GET /api/talk': async (_req, res, url) => {
    const id = url.pathname.split('/').pop();
    const note = lib.findTalkById(id);
    if (!note) return fail(res, 404, 'Talk not found');
    const talk = lib.parseTalkNote(note);
    // Saved words are stored as lemmas, but the transcript contains surface forms
    // ("trilobites", "ushered"). Ship a token→lemma map so highlighting is consistent
    // for inflected words, not just the ones that happen to be their own headword.
    const lemmas = {};
    const seen = new Set();
    for (const para of [...talk.paragraphs, ...(talk.reviewed || [])]) {
      for (const tok of para.toLowerCase().match(/[a-z][a-z'’-]*/g) || []) {
        const token = tok.replace(/[’']s$/, '');
        if (token.length < 2 || seen.has(token)) continue;
        seen.add(token);
        const lemma = dictLemmatize(token);
        if (lemma !== token) lemmas[token] = lemma;
      }
    }
    // Every word she has saved anywhere — a word learned in one talk should stay gold
    // when she meets it again in another.
    const savedWords = idx.queryWords({}).map((w) => w.word);

    // Who is speaking, paragraph by paragraph. In a two-hander the talk's `speaker` field is
    // both names joined, so a line quoted into 03-phrases would otherwise be credited to the
    // pair rather than to whoever said it. Derived from the turn markers already in the text.
    const labels = knownLabels(talk.paragraphs);
    const speakers = talk.paragraphs.map((para) => {
      const turn = speakerLabel(para, labels);
      return turn ? displayName(turn.who, labels) : (labels.size ? '' : talk.speaker || '');
    });

    patchFrontmatter(note.path, { last_opened: new Date().toISOString().slice(0, 10) });
    ok(res, { talk, savedWords, lemmas, speakers });
  },

  // The corrected layer is authored by the review pass and written here. It never
  // replaces `## Transcript` — the verbatim text is what she actually heard, and the
  // cue timings key off it.
  'POST /api/talk/review': async (req, res, url) => {
    const id = url.pathname.split('/').filter(Boolean).at(-2);
    const { paragraphs, corrections, languageNotes } = await readBody(req);
    if (!Array.isArray(paragraphs) || !paragraphs.length) return fail(res, 400, 'No reviewed paragraphs given');
    let result;
    try {
      result = lib.writeReviewedLayer(id, { paragraphs, corrections, languageNotes });
    } catch (err) {
      return fail(res, 400, err.message);
    }
    const note = lib.findTalkById(id);
    idx.indexTalk({ ...note.frontmatter, rel: note.rel }, lib.parseTalkNote(note));
    notion.scheduleSync(id, 1000);
    ok(res, result);
  },

  // Polish — Claude proposes corrections, lib/polish.js decides whether to believe them.
  // Slow by design (a minute or so on a long talk); the button shows a spinner meanwhile.
  'POST /api/talk/polish': async (_req, res, url) => {
    const id = url.pathname.split('/').filter(Boolean).at(-2);
    let result;
    try {
      result = await polish.polishTalk(id, { force: url.searchParams.get('force') === '1' });
    } catch (err) {
      return fail(res, 400, err.message);
    }
    const note = lib.findTalkById(id);
    idx.indexTalk({ ...note.frontmatter, rel: note.rel }, lib.parseTalkNote(note));
    notion.scheduleSync(id, 1000);
    ok(res, result);
  },

  // Backfill: tag every talk whose source gave us no topics.
  'POST /api/tag-untagged': async (_req, res) => {
    const done = [];
    const failed = [];
    for (const t of lib.allTalks()) {
      if ((t.topics || []).length) continue;
      try {
        done.push(await topics.tagTalk(t.id));
      } catch (err) {
        failed.push({ id: t.id, error: err.message });
      }
    }
    for (const r of done) notion.scheduleSync(r.id, 1000);
    ok(res, { tagged: done, failed });
  },

  'GET /api/polish-status': async (_req, res) => ok(res, { configured: polish.configured(), backend: polish.backend() }),

  'POST /api/ingest': async (req, res) => {
    const body = await readBody(req);
    const url = String(body.url || '').trim();
    if (url) {
      const dupe = lib.findTalkByUrl(url);
      if (dupe) return ok(res, { id: dupe.frontmatter.id, created: false, duplicate: true });
    }
    const talk = await resolveSource(body);
    const saved = lib.saveTalk(talk);

    // TED supplies topics; YouTube and pasted text do not, and an untagged talk lands in Notion
    // with an empty Category — invisible to every filter she has built there. Tagging must never
    // fail the ingest, though: a talk in the vault without topics beats no talk at all.
    let tagged = talk.topics || [];
    if (!tagged.length) {
      try {
        ({ topics: tagged } = await topics.tagTalk(saved.id));
      } catch (err) {
        console.error(`[tag ${saved.id}]`, err.message);
      }
    }

    const note = lib.findTalkById(saved.id);
    idx.indexTalk({ ...note.frontmatter, rel: note.rel }, lib.parseTalkNote(note));
    notion.scheduleSync(saved.id, 1000);
    ok(res, { id: saved.id, created: saved.created, duplicate: !saved.created, title: talk.title, topics: tagged });
  },

  // Natural-voice pronunciation for words with no recorded audio. Proxied rather than
  // fetched from the page so the browser's cross-origin rules do not block it.
  'GET /api/tts': async (_req, res, url) => {
    const word = (url.searchParams.get('word') || '').slice(0, 60);
    if (!word) return fail(res, 400, 'No word given');
    const accent = url.searchParams.get('accent') === 'uk' ? 'en-GB' : 'en-US';
    const upstream = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(word)}&tl=${accent}&client=tw-ob`;

    const r = await fetch(upstream, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://translate.google.com/' } });
    if (!r.ok) return fail(res, 502, 'Pronunciation service unavailable');
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
    res.end(Buffer.from(await r.arrayBuffer()));
  },

  'POST /api/lookup': async (req, res) => {
    const { word, context, contextRef, talkTitle, talkUrl } = await readBody(req);
    if (!word) return fail(res, 400, 'No word given');
    const card = await buildCard(word, { context, contextRef, talkTitle, talkUrl });
    const existing = readNote(lib.vocabPath(card.lemma));
    ok(res, { ...card, saved: Boolean(existing), status: existing?.frontmatter?.status || null });
  },

  'POST /api/word': async (req, res) => {
    const { word, context, contextRef, talkId, talkTitle, talkUrl } = await readBody(req);
    if (!word) return fail(res, 400, 'No word given');
    const card = await buildCard(word, { context, contextRef, talkTitle, talkUrl });
    const saved = lib.saveWord(card, { talkId, talkTitle });
    idx.indexWord(saved.frontmatter);
    // No counter to bump — per-talk word counts are derived from the words table.
    notion.scheduleSync(talkId);
    ok(res, { word: card.lemma, created: saved.created, notion: notion.configured() });
  },

  'POST /api/word-status': async (req, res) => {
    const { word, status } = await readBody(req);
    const abs = lib.vocabPath(word);
    if (!readNote(abs)) return fail(res, 404, 'Word not found');
    patchFrontmatter(abs, { status });
    const fm = readNote(abs).frontmatter;
    idx.indexWord(fm);
    notion.scheduleSync(fm.talk);
    ok(res, { word, status });
  },

  'POST /api/word-delete': async (req, res) => {
    const { word } = await readBody(req);
    const abs = lib.vocabPath(word);
    const note = readNote(abs);
    if (!note) return fail(res, 404, 'Word not found');
    const talkId = note.frontmatter.talk;
    fs.rmSync(abs);
    idx.removeWord(word);
    notion.scheduleSync(talkId);
    ok(res, { word, deleted: true });
  },

  'GET /api/words': async (_req, res, url) => {
    const p = url.searchParams;
    ok(res, {
      rows: idx.queryWords({
        status: p.get('status') || undefined,
        talk: p.get('talk') || undefined,
        tag: p.get('tag') || undefined,
        q: p.get('q') || undefined,
      }),
    });
  },

  'POST /api/review': async (req, res) => {
    const body = await readBody(req);
    for (const r of body.results || []) {
      const abs = lib.vocabPath(r.word);
      const note = readNote(abs);
      if (!note) continue;
      patchFrontmatter(abs, {
        times_tested: (Number(note.frontmatter.times_tested) || 0) + 1,
        times_correct: (Number(note.frontmatter.times_correct) || 0) + (r.correct ? 1 : 0),
        last_reviewed: new Date().toISOString().slice(0, 10),
        status: note.frontmatter.status === 'new' ? 'learning' : note.frontmatter.status,
      });
      idx.indexWord(readNote(abs).frontmatter);
    }
    const seen = (body.results || []).length;
    const correct = (body.results || []).filter((r) => r.correct).length;
    const day = review.logSession({ type: body.type || 'test', seen, correct, seconds: body.seconds || 0, talk: body.talkTitle || '' });
    ok(res, { logged: true, seen, correct, day });
  },

  'GET /api/sheet': async (_req, res, url) => {
    const p = url.searchParams;
    const sheet = buildSheet({
      scope: p.get('scope') || 'all',
      value: p.get('value') || '',
      format: p.get('format') || 'json',
    });
    if (sheet.format === 'json') return ok(res, sheet);
    send(res, 200, sheet.content, sheet.mime);
  },

  'POST /api/resync': async (_req, res) => ok(res, idx.rebuild()),

  // Push a talk to Notion now, rather than waiting for the debounce.
  'POST /api/notion-sync': async (req, res) => {
    if (!notion.configured()) {
      return fail(res, 400, 'Notion not connected — add NOTION_TOKEN and NOTION_DATABASE_ID to .env');
    }
    const { talkId } = await readBody(req);
    const ids = talkId ? [talkId] : lib.allTalks().map((t) => t.id);
    const results = [];
    for (const id of ids) results.push({ id, ...(await notion.syncTalk(id)) });
    ok(res, { synced: results });
  },

  'GET /api/notion-status': async (_req, res) => ok(res, { configured: notion.configured() }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  try {
    // Prefix routes for /api/talk/:id and its verbs (/review, /polish).
    const verb = ['review', 'polish'].find((v) => pathname.endsWith(`/${v}`)) || '';
    const key = pathname.startsWith('/api/talk/')
      ? `${req.method} /api/talk${verb ? `/${verb}` : ''}`
      : `${req.method} ${pathname}`;
    const handler = routes[key];
    if (handler) return await handler(req, res, url);

    // Pretty URLs for the SPA-ish pages.
    if (pathname.startsWith('/read/')) return void serveStatic(req, res, '/reader.html');
    if (serveStatic(req, res, pathname)) return;
    if (serveStatic(req, res, `${pathname}.html`)) return;

    fail(res, 404, 'Not found');
  } catch (err) {
    console.error(`[${req.method} ${pathname}]`, err.message);
    fail(res, 500, err.message);
  }
});

ensureVault();
fs.mkdirSync(vaultPath(DIRS.review), { recursive: true });
const counts = idx.ensureIndex();
server.listen(PORT, () => {
  console.log(`English Partner  →  http://localhost:${PORT}`);
  console.log(`vault: ${VAULT}  (${counts.talks} talks, ${counts.words} words indexed)`);
});
