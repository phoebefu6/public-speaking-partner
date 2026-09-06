// Which sense of the word is being used *here*?
//
// A dictionary hands you every meaning a word has ever had. Standing in front of a
// sentence, only one of them is the point. This module picks the most likely sense for
// the sentence the word was met in, and surfaces the phrasing it appears in.
//
// This is a heuristic, not a parser. It is labelled as an inference in the UI so a wrong
// guess is visibly a guess rather than a false fact.

const STOP = new Set(
  ('a an the of to in on at for with by from as is are was were be been being that this these those ' +
   'it its his her their our your my and or but not no so if then than there here what which who whom ' +
   'when where how all any both each few more most other some such only own same very can will just ' +
   'do does did done have has had having would could should may might must one two i you he she we they')
    .split(' ')
);

const PARTICLES = new Set(
  ['in', 'out', 'up', 'off', 'on', 'into', 'onto', 'over', 'under', 'through', 'across',
   'down', 'away', 'back', 'along', 'around', 'about', 'with', 'without', 'to', 'for',
   'from', 'at', 'by', 'against', 'upon', 'forward', 'together', 'apart']
);

const words = (s) =>
  String(s || '').toLowerCase().match(/[a-z][a-z'-]*/g) || [];

const contentWords = (s) => words(s).filter((w) => w.length > 2 && !STOP.has(w));

/** Map a dictionaryapi part of speech onto the prefix ECDICT uses on its Chinese lines. */
const POS_PREFIX = {
  noun: /^\[?n/i,
  verb: /^\[?(v|vt|vi)/i,
  adjective: /^\[?a(dj)?/i,
  adverb: /^\[?ad(v)?/i,
  preposition: /^\[?prep/i,
  conjunction: /^\[?conj/i,
  pronoun: /^\[?pron/i,
  interjection: /^\[?int/i,
};

/**
 * The phrase the word actually appears in — "ushered in", "brimming with".
 * For a speaker this matters more than the bare headword: it is the unit you reuse.
 */
export function collocation(sentence, surface) {
  const toks = String(sentence).match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const i = toks.findIndex((t) => t.toLowerCase() === String(surface).toLowerCase());
  if (i === -1) return '';

  const next = toks[i + 1]?.toLowerCase();
  if (next && PARTICLES.has(next)) return `${toks[i]} ${toks[i + 1]}`;

  const prev = toks[i - 1]?.toLowerCase();
  if (prev && PARTICLES.has(prev) && i > 0) return `${toks[i - 1]} ${toks[i]}`;
  return '';
}

const DETERMINERS = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your',
  'his', 'her', 'its', 'our', 'their', 'some', 'any', 'each', 'every', 'no', 'another']);
const AUXILIARIES = new Set(['have', 'has', 'had', 'having', 'be', 'is', 'are', 'was', 'were',
  'been', 'being', 'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must']);

/** ECDICT inflection tag → the part of speech it implies. */
const INFLECTION_POS = { p: 'verb', d: 'verb', i: 'verb', 3: 'verb', s: 'noun', r: 'adjective', t: 'adjective' };

/**
 * Grammatical evidence for the part of speech, strongest signal first. This is what stops
 * the card offering "a person who escorts people to their seats" for "ushered in".
 */
export function posHint({ sentence, surface, inflection }) {
  // 1. Inflection is decisive — a past tense is a verb, whatever else the headword can be.
  if (inflection && INFLECTION_POS[inflection]) return INFLECTION_POS[inflection];

  const toks = String(sentence || '').match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const i = toks.findIndex((t) => t.toLowerCase() === String(surface).toLowerCase());
  if (i === -1) return null;

  const prev = toks[i - 1]?.toLowerCase();
  const next = toks[i + 1]?.toLowerCase();

  if (next && PARTICLES.has(next) && next !== 'to') return 'verb';  // phrasal verb
  if (prev && AUXILIARIES.has(prev)) return 'verb';
  if (prev && DETERMINERS.has(prev)) return 'noun';
  return null;
}

/**
 * Rank the available senses against the sentence.
 * Returns { english, zh, confident } — english/zh may be null when there is nothing to pick.
 */
export function senseInContext({ context, englishDefs = [], zh = '', surface = '', inflection = null, phrase = '' }) {
  if (!context || !englishDefs.length) return { english: null, zh: null, confident: false };

  const ctx = new Set(contentWords(context));
  const hint = posHint({ sentence: context, surface, inflection });

  // Grammar first: if the word is a verb here, never offer a noun sense, however well
  // its wording happens to overlap.
  const pool = hint ? englishDefs.filter((d) => d.pos === hint) : [];
  const candidates = pool.length ? pool : englishDefs;

  let best = null;
  let bestScore = 0;
  let runnerUp = 0;

  // When the word appears as a phrasal verb, a definition that mentions the particle is
  // far more likely to be the right reading.
  const particle = phrase ? phrase.split(/\s+/).pop()?.toLowerCase() : '';

  for (const def of candidates) {
    const defWords = contentWords(def.text);
    if (!defWords.length) continue;
    // Overlap normalised by definition length, so a long rambling gloss does not win
    // simply by containing more words.
    const hits = defWords.filter((w) => ctx.has(w)).length;
    let score = hits / Math.sqrt(defWords.length);
    if (particle && new RegExp(`\\b${particle}\\b`, 'i').test(def.text)) score += 0.5;
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = def;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  const chosen = best || candidates[0] || null;
  // Confident when grammar narrowed the field to one or two readings, or when a single
  // sense clearly won on wording. Otherwise the card says it is a guess.
  const narrowedByGrammar = Boolean(hint) && pool.length > 0 && pool.length <= 2;
  const confident = narrowedByGrammar || (bestScore > 0 && bestScore - runnerUp > 0.15);

  // Pair it with the Chinese line for the same part of speech.
  let zhLine = null;
  if (chosen?.pos && zh) {
    const pattern = POS_PREFIX[chosen.pos];
    if (pattern) zhLine = zh.split('\n').find((line) => pattern.test(line.trim())) || null;
  }

  // The phrase is used here but no sense actually accounts for it. Say so — a phrasal
  // verb usually means something the base verb does not.
  const phrasalUnresolved = Boolean(particle) &&
    Boolean(chosen) && !new RegExp(`\\b${particle}\\b`, 'i').test(chosen.text);

  return {
    phrasalUnresolved,
    english: chosen,
    zh: zhLine,
    confident: Boolean(chosen) && confident,
    // How many other senses exist — worth showing so she knows the word has range.
    otherSenses: Math.max(0, englishDefs.length - 1),
  };
}
