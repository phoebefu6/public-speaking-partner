// Search index over the vault.
//
// This file is a CACHE and nothing else. Every byte in it is derived from Markdown in
// ~/speech-vault, and `npm run resync` throws it away and rebuilds. That property is
// what lets the vault stay the source of truth while the catalog still answers
// full-text queries across a very large library instantly.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { allTalks, allWords, parseTalkNote } from './library.js';
import { DIRS, listNotes, readNote } from './vault.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(HERE, '..', 'data', 'cache.db');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS talks (
  id TEXT PRIMARY KEY, title TEXT, speaker TEXT, source TEXT, url TEXT, poster TEXT,
  duration INTEGER, words INTEGER, difficulty TEXT, topics TEXT, collection TEXT,
  status TEXT, added TEXT, last_opened TEXT, new_words INTEGER, mastered INTEGER, rel TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS talks_fts USING fts5(
  id UNINDEXED, title, speaker, topics, transcript, tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS words (
  word TEXT PRIMARY KEY, zh TEXT, band TEXT, exam_tags TEXT, status TEXT,
  talk TEXT, talk_title TEXT, context TEXT, times_tested INTEGER, times_correct INTEGER,
  last_reviewed TEXT, added TEXT, ipa_uk TEXT, ipa_us TEXT, audio_uk TEXT, audio_us TEXT
);
CREATE INDEX IF NOT EXISTS idx_talk_status ON talks(status);
CREATE INDEX IF NOT EXISTS idx_word_status ON words(status);
CREATE INDEX IF NOT EXISTS idx_word_talk ON words(talk);
`;

export function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

const asList = (v) => (Array.isArray(v) ? v.join(', ') : String(v || ''));

export function indexTalk(talkFm, parsed) {
  const d = open();
  d.prepare('DELETE FROM talks WHERE id = ?').run(talkFm.id);
  d.prepare('DELETE FROM talks_fts WHERE id = ?').run(talkFm.id);
  d.prepare(
    `INSERT INTO talks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    talkFm.id, talkFm.title || '', talkFm.speaker || '', talkFm.source || '', talkFm.url || '',
    talkFm.poster || '', Number(talkFm.duration) || 0, Number(talkFm.words) || 0,
    talkFm.difficulty || '', asList(talkFm.topics), talkFm.collection || '',
    talkFm.status || 'inbox', talkFm.added || '', talkFm.last_opened || '',
    Number(talkFm.new_words) || 0, Number(talkFm.mastered) || 0, talkFm.rel || ''
  );
  d.prepare('INSERT INTO talks_fts VALUES (?,?,?,?,?)').run(
    talkFm.id, talkFm.title || '', talkFm.speaker || '', asList(talkFm.topics),
    (parsed?.paragraphs || []).join('\n')
  );
}

export function indexWord(fm) {
  const d = open();
  d.prepare(
    `INSERT OR REPLACE INTO words VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    fm.word, (fm.zh || '').split('\n')[0], fm.band || '', asList(fm.exam_tags), fm.status || 'new',
    fm.talk || '', fm.talk_title || '', fm.context || '',
    Number(fm.times_tested) || 0, Number(fm.times_correct) || 0,
    // Fall back to the accent-neutral transcription so the list always shows something.
    fm.last_reviewed || '', fm.added || '', fm.ipa_uk || fm.ipa || '', fm.ipa_us || fm.ipa || '',
    fm.audio_uk || '', fm.audio_us || ''
  );
}

export function removeWord(word) {
  open().prepare('DELETE FROM words WHERE word = ?').run(word);
}

/** Full rebuild from the vault. The proof that nothing lives only in the cache. */
export function rebuild({ log = () => {} } = {}) {
  if (db) { db.close(); db = null; }
  if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(DB_PATH + suffix)) fs.rmSync(DB_PATH + suffix);
  }
  open();

  let talks = 0;
  for (const abs of listNotes(DIRS.talks)) {
    const note = readNote(abs);
    if (note?.frontmatter?.type !== 'talk') continue;
    indexTalk({ ...note.frontmatter, rel: note.rel }, parseTalkNote(note));
    talks++;
  }
  let words = 0;
  for (const fm of allWords()) { indexWord(fm); words++; }

  log(`indexed ${talks} talks, ${words} words`);
  return { talks, words };
}

/** Rebuild only if the cache is empty or missing — cheap startup path. */
export function ensureIndex() {
  open();
  const t = db.prepare('SELECT COUNT(*) n FROM talks').get().n;
  const w = db.prepare('SELECT COUNT(*) n FROM words').get().n;
  const vaultTalks = allTalks().length;
  const vaultWords = allWords().length;
  if (t !== vaultTalks || w !== vaultWords) return rebuild();
  return { talks: t, words: w };
}

// ------------------------------------------------------------------ queries

/** Escape user input for FTS5 — a bare quote or operator would otherwise throw. */
const ftsQuote = (q) =>
  String(q).trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');

export function searchTalks({ q = '', source, difficulty, status, topic, limit = 40, offset = 0 } = {}) {
  const d = open();
  const where = [];
  const args = [];
  let from = 'talks t';

  if (q.trim()) {
    from = 'talks t JOIN talks_fts f ON f.id = t.id';
    where.push('talks_fts MATCH ?');
    args.push(ftsQuote(q));
  }
  for (const [col, val] of [['source', source], ['difficulty', difficulty], ['status', status]]) {
    if (val) { where.push(`t.${col} = ?`); args.push(val); }
  }
  if (topic) { where.push('t.topics LIKE ?'); args.push(`%${topic}%`); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = q.trim() ? 'ORDER BY rank' : 'ORDER BY t.added DESC, t.id DESC';

  // Word counts are DERIVED, never stored. A stored counter drifts the moment a word is
  // deleted, and then every progress ring on the page is quietly wrong.
  const rows = d.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM words w WHERE w.talk = t.id) AS new_words,
      (SELECT COUNT(*) FROM words w WHERE w.talk = t.id AND w.status IN ('known','retired')) AS mastered
    FROM ${from} ${clause} ${order} LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  const total = d.prepare(`SELECT COUNT(*) n FROM ${from} ${clause}`).get(...args).n;
  return { rows, total, offset, limit };
}

export function facets() {
  const d = open();
  const group = (col) =>
    d.prepare(`SELECT ${col} AS value, COUNT(*) n FROM talks WHERE ${col} != '' GROUP BY ${col} ORDER BY n DESC`).all();
  const topics = new Map();
  for (const { topics: list } of d.prepare("SELECT topics FROM talks WHERE topics != ''").all()) {
    for (const t of String(list).split(',').map((s) => s.trim()).filter(Boolean)) {
      topics.set(t, (topics.get(t) || 0) + 1);
    }
  }
  return {
    source: group('source'),
    difficulty: group('difficulty'),
    status: group('status'),
    topics: [...topics.entries()].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n).slice(0, 30),
  };
}

export function queryWords({ status, talk, tag, q, limit = 500 } = {}) {
  const d = open();
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (talk) { where.push('talk = ?'); args.push(talk); }
  if (tag) { where.push('exam_tags LIKE ?'); args.push(`%${tag}%`); }
  if (q) { where.push('(word LIKE ? OR zh LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return d.prepare(`SELECT * FROM words ${clause} ORDER BY added DESC, word LIMIT ?`).all(...args, limit);
}

export function getTalk(id) {
  return open().prepare('SELECT * FROM talks WHERE id = ?').get(id);
}
