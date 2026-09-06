// Speaker labels and stage directions.
//
// A dialogue transcript carries text that is not language to study: "SK:" marking whose
// turn it is, "(Applause)" marking the room. Both must stay visible — they are part of
// what she heard — but neither is a word to look up, to count, or to grade. Everything
// that needs to tell the two apart imports from here, so the reader, the word count and
// the grader can never drift out of agreement.
//
// Imported by the browser as a static file and by the server as a plain ES module.

/** "Sal Khan: ", "RH: " — a turn marker at the very start of a paragraph or cue. */
const LABEL = /^([A-Z][a-z]+(?: [A-Z][a-z]+)?|[A-Z]{2,4}):\s/;

/** TED's stage directions. A closed list: a generic "(Anything)" would eat real asides. */
const STAGE = new RegExp(
  '\\((?:(?:[A-Za-z]+ )?(?:Applause|Laughter|Cheers|Music|Video|Audio|Singing|Sighs?|Chuckles?)'
  + '(?: and [a-z]+)?)\\)', 'g',
);

/**
 * Caption-file typography, settled once for every source.
 *
 * "--" is a stand-in for an em dash and "don\u2019t" is the same word as "don't"; leaving both
 * spellings in the vault means the same sentence can be stored two ways, and a difficulty grade
 * can move because a transcript preferred straight quotes. Punctuation only — no word changes.
 */
export function normalizePunctuation(s) {
  return String(s)
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s*--\s*/g, ' \u2014 ')
    .replace(/(\w)'(\w)/g, '$1\u2019$2')
    .replace(/(\w)'(?=\s|$)/g, '$1\u2019')
    .replace(/\s+/g, ' ')
    .trim();
}

const initialsOf = (label) => label.split(/\s+/).map((w) => w[0]).join('');

/**
 * The turn markers this particular talk actually uses.
 *
 * Self-calibrating, because guessing from shape alone would read "Fact:" as a speaker.
 * A marker qualifies by recurring, or by being the long form of one that recurs — TED
 * writes the full name on a speaker's first turn and their initials on every one after,
 * so "Sal Khan" appears exactly once and would otherwise never qualify on its own.
 */
const ANYWHERE = /(?:^|(?<=[.?!"\u201d\u2019)])\s)([A-Z][a-z]+(?: [A-Z][a-z]+)?|[A-Z]{2,4}):\s/g;

export function knownLabels(paragraphs) {
  const counts = new Map();
  const opensAParagraph = new Set();
  for (const p of paragraphs) {
    // Counted anywhere in the paragraph, not just at its head: a pasted transcript often runs
    // several turns together, and those markers are exactly the ones that need finding.
    for (const m of String(p || '').matchAll(ANYWHERE)) {
      counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    const head = LABEL.exec(p || '');
    if (head) opensAParagraph.add(head[1]);
  }

  const accepted = new Set([...counts].filter(([, n]) => n >= 2).map(([l]) => l));
  for (const label of counts.keys()) {
    // TED writes the full name on a speaker's first turn and their initials on every one
    // after, so "Sal Khan" appears exactly once and would never qualify on its own.
    if (accepted.has(initialsOf(label)) || counts.has(initialsOf(label))) {
      accepted.add(label);
      accepted.add(initialsOf(label));
    }
  }
  // Once a talk is known to be a dialogue, a marker opening a paragraph is a turn even if it
  // is the only line that speaker gets.
  if (accepted.size) for (const label of opensAParagraph) accepted.add(label);
  return accepted;
}

/** The turn marker opening this paragraph, if it is one this talk uses. */
export function speakerLabel(paragraph, labels) {
  const m = LABEL.exec(paragraph || '');
  if (!m || (labels && !labels.has(m[1]))) return null;
  return { who: m[1], start: 0, end: m[0].length };
}

/** Resolve "SK" to "Sal Khan" when the talk introduced them by name. */
export function displayName(label, labels) {
  if (!labels) return label;
  for (const other of labels) {
    if (other !== label && initialsOf(other) === label) return other;
  }
  return label;
}

/** Character ranges holding nothing to look up: the turn marker and any stage direction. */
export function nonLexicalRanges(paragraph, labels) {
  const ranges = [];
  const label = speakerLabel(paragraph, labels);
  if (label) ranges.push({ start: label.start, end: label.end });
  for (const m of String(paragraph || '').matchAll(STAGE)) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** The paragraph with turn markers and stage directions stripped — the language itself. */
export function lexicalText(paragraph, labels) {
  let out = '';
  let cursor = 0;
  for (const r of nonLexicalRanges(paragraph, labels)) {
    out += String(paragraph).slice(cursor, r.start);
    cursor = r.end;
  }
  return (out + String(paragraph).slice(cursor)).replace(/\s+/g, ' ').trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Break any paragraph holding more than one turn.
 *
 * Sources that arrive as prose rather than as timed cues — a pasted transcript, YouTube
 * captions regrouped by length — put a reply and the next question in one block. Every line
 * in such a block is attributed to whoever spoke first, so split before the second marker.
 */
export function splitOnTurns(paragraphs) {
  const labels = knownLabels(paragraphs);
  if (!labels.size) return paragraphs;
  const alternation = [...labels].map(escapeRe).join('|');
  const at = new RegExp(`(?<=[.?!"\u201d\u2019)])\\s+(?=(?:${alternation}):\\s)`, 'g');
  return paragraphs.flatMap((p) => String(p).split(at).map((s) => s.trim()).filter(Boolean));
}

/** Words she is actually reading, across the whole talk. */
export function countWords(paragraphs) {
  const labels = knownLabels(paragraphs);
  return paragraphs.reduce(
    (n, p) => n + lexicalText(p, labels).split(/\s+/).filter(Boolean).length, 0,
  );
}

export { LABEL, STAGE };
