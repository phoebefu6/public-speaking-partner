// Offline English→Chinese dictionary backed by ECDICT (770k entries).
//
// The lemma table is what makes highlighting usable: transcripts contain "emerged",
// "ushering", "inhabitants" — not the dictionary headwords. Resolve first, look up second.

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(HERE, '..', 'data', 'ecdict.db');

let db, stmts;

function connect() {
  if (db) return;
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  stmts = {
    entry: db.prepare(
      'SELECT word, phonetic, translation, definition, pos, tag, collins, oxford, frq, bnc, exchange FROM ecdict WHERE word = ?'
    ),
    lemma: db.prepare('SELECT base FROM lemma WHERE form = ?'),
  };
}

/** Exam tags ECDICT uses, mapped to labels worth showing. */
const TAG_LABELS = {
  zk: '中考', gk: '高考', ky: '考研', cet4: 'CET4', cet6: 'CET6',
  toefl: 'TOEFL', ielts: 'IELTS', gre: 'GRE',
};

// ECDICT gives many inflections their own entry, but glosses them as nothing more than
// "<base>的过去式". Those must still resolve to the base — otherwise the word loses its exam
// tags, its band, and its pronunciation audio. A form with real independent meaning
// ("meeting" n. 会议) keeps its own entry.
const INFLECTION_GLOSS = /的(过去式|过去分词|现在分词|第三人称|单三|复数|比较级|最高级|变形|变体)/;

const unescapeLines = (s) => String(s || '').replace(/\\n/g, '\n').trim();

function isPureInflection(row) {
  const zh = String(row?.translation || '');
  if (!zh) return false;
  return zh
    .split('\n')
    .filter(Boolean)
    .every((line) => INFLECTION_GLOSS.test(line));
}

/** Resolve an inflected form to its dictionary headword. Returns the input if already a base. */
export function lemmatize(word) {
  connect();
  const w = String(word).toLowerCase().trim();
  if (!w) return w;

  const hit = stmts.lemma.get(w);
  const own = stmts.entry.get(w);

  if (hit?.base) {
    const base = String(hit.base).toLowerCase();
    // Keep the surface form only when it carries meaning the base does not.
    if (!own || isPureInflection(own)) return base;
    return w;
  }
  if (own) return w;

  // Fall back to naive suffix stripping for forms ECDICT does not enumerate.
  for (const [re, repl] of [
    [/ies$/, 'y'], [/ied$/, 'y'], [/ying$/, 'ie'],
    [/([^aeiou])\1ing$/, '$1'], [/([^aeiou])\1ed$/, '$1'],
    [/ing$/, ''], [/ing$/, 'e'], [/ed$/, ''], [/ed$/, 'e'],
    [/es$/, ''], [/s$/, ''],
  ]) {
    const candidate = w.replace(re, repl);
    if (candidate !== w && candidate.length > 2 && stmts.entry.get(candidate)) return candidate;
  }
  return w;
}

/**
 * What kind of inflection is this surface form? ECDICT's `exchange` field tags it:
 *   p past tense · d past participle · i present participle · 3 third-person singular
 *   s plural · r comparative · t superlative
 * This is hard grammatical evidence about part of speech — "ushered" is a past tense,
 * therefore a verb, whatever else the dictionary lists the headword as.
 */
export function inflectionOf(surface) {
  connect();
  const row = stmts.entry.get(String(surface).toLowerCase().trim());
  if (!row?.exchange) return null;
  for (const part of String(row.exchange).split('/')) {
    if (part.startsWith('1:')) return part.slice(2).trim() || null;
  }
  return null;
}

/** Full ECDICT record for a word, lemmatizing first. Null when genuinely unknown. */
export function lookup(word) {
  connect();
  const original = String(word).toLowerCase().trim();
  const lemma = lemmatize(original);
  const row = stmts.entry.get(lemma) || stmts.entry.get(original);
  if (!row) return null;

  const tags = String(row.tag || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => TAG_LABELS[t] || t);

  return {
    word: row.word,
    lemma,
    inflected: original !== lemma ? original : null,
    phonetic: row.phonetic || '',
    // ECDICT stores line breaks as the two characters \ and n, not as real newlines.
    zh: unescapeLines(row.translation),
    definition: unescapeLines(row.definition),
    pos: (row.pos || '').trim(),
    tags,
    collins: row.collins || 0,
    oxford: row.oxford || 0,
    frq: row.frq || 0,
    bnc: row.bnc || 0,
  };
}

/**
 * Rough CEFR band from frequency and Collins rating. Used to grade whole talks,
 * not to be precious about any single word.
 */
export function bandOf(entry) {
  if (!entry) return 'C2';
  const f = entry.frq || entry.bnc || 0;
  if (entry.collins >= 5 || (f && f < 1500)) return 'A2';
  if (entry.collins === 4 || (f && f < 4000)) return 'B1';
  if (entry.collins === 3 || (f && f < 9000)) return 'B2';
  if (entry.collins >= 1 || (f && f < 20000)) return 'C1';
  return 'C2';
}

export function close() {
  db?.close();
  db = null;
}
