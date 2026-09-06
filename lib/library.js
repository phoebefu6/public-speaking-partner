// Talks and vocabulary as vault notes.
//
// A talk note is readable on its own in Obsidian: metadata up top, the transcript as
// prose, a craft section to fill in by hand, and the cue timings tucked in a fenced
// block at the bottom where they stay out of the way but survive a cache wipe.

import fs from 'node:fs';
import path from 'node:path';
import * as dict from './dict.js';
import { knownLabels, lexicalText } from '../public/labels.js';
import { DIRS, listNotes, nextTalkId, readNote, slugify, vaultPath, writeNote } from './vault.js';

const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------- talks

export function talkPath(talk) {
  const year = (talk.recordedAt || today()).slice(0, 4);
  return vaultPath(DIRS.talks, talk.source.toLowerCase(), year, `${slugify(talk.title)}.md`);
}

/** Grade a talk by how much of its vocabulary sits above the common core. */
export function gradeTalk(paragraphs) {
  // Speaker initials and stage directions are not vocabulary; grading them would count
  // "SK" and "Applause" among the words she is being measured against.
  const labels = knownLabels(paragraphs);
  const counts = new Map();
  for (const p of paragraphs) {
    // Apostrophes are folded to one shape first: "it’s" and "it's" are the same word, and a
    // grade that moves because a transcript prefers curly quotes is measuring punctuation.
    const text = lexicalText(p, labels).toLowerCase().replace(/\u2019/g, "'");
    for (const w of text.match(/[a-z][a-z'-]+/g) || []) {
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  let hard = 0;
  let total = 0;
  for (const w of counts.keys()) {
    const band = dict.bandOf(dict.lookup(w));
    total++;
    if (band === 'C1' || band === 'C2') hard++;
  }
  const ratio = total ? hard / total : 0;
  if (ratio < 0.12) return 'A2';
  if (ratio < 0.2) return 'B1';
  if (ratio < 0.3) return 'B2';
  if (ratio < 0.42) return 'C1';
  return 'C2';
}

export function talkToNote(talk, id) {
  const frontmatter = {
    id,
    type: 'talk',
    title: talk.title,
    speaker: talk.speaker,
    source: talk.source,
    url: talk.url,
    date: talk.recordedAt || '',   // when the talk was given, not when it was ingested
    embed: talk.embed || '',
    poster: talk.poster || '',
    duration: talk.duration || 0,
    words: talk.words,
    difficulty: gradeTalk(talk.paragraphs),
    topics: talk.topics || [],
    collection: '',
    status: 'inbox',
    added: today(),
    last_opened: '',
    new_words: 0,
    mastered: 0,
    notion_page: '',
  };

  const body = [
    talk.description ? `> ${talk.description}\n` : '',
    '## Transcript\n',
    talk.paragraphs.join('\n\n'),
    '\n\n## Speech craft\n',
    '*How does this talk work? Fill in as you study it.*\n',
    '- **Opening move:** ',
    '- **Structure:** ',
    '- **Rhetorical devices:** ',
    '- **Closing move:** ',
    '- **Delivery to steal:** ',
    '\n## Words from this talk\n',
    '*Populated automatically as you highlight.*\n',
    '\n## Cues\n',
    '```json',
    JSON.stringify(talk.cues),
    '```',
  ].join('\n');

  return { frontmatter, body };
}

export function saveTalk(talk) {
  const abs = talkPath(talk);
  if (fs.existsSync(abs)) return { path: abs, created: false, id: readNote(abs).frontmatter.id };
  const id = nextTalkId();
  const { frontmatter, body } = talkToNote(talk, id);
  writeNote(abs, frontmatter, body);
  return { path: abs, created: true, id };
}

export function findTalkByUrl(url) {
  const norm = String(url).replace(/\/transcript\/?$/, '').replace(/\/+$/, '').toLowerCase();
  for (const abs of listNotes(DIRS.talks)) {
    const fm = readNote(abs)?.frontmatter;
    if (String(fm?.url || '').replace(/\/+$/, '').toLowerCase() === norm) return { path: abs, frontmatter: fm };
  }
  return null;
}

export function findTalkById(id) {
  for (const abs of listNotes(DIRS.talks)) {
    const note = readNote(abs);
    if (note?.frontmatter?.id === id) return note;
  }
  return null;
}

const headingRe = (title) =>
  new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \t]*$`, 'm');

/** Body text under an exact `## <title>` heading, up to the next level-2 heading. */
function section(body, title) {
  const m = headingRe(title).exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** Remove a whole `## <title>` section, heading included. */
function dropSection(body, title) {
  const m = headingRe(title).exec(body);
  if (!m) return body;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return body.slice(0, m.index) + (next === -1 ? '' : rest.slice(next));
}

const toParagraphs = (text) =>
  String(text || '').trim().split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

const fencedJson = (body, title) => {
  const m = body.match(new RegExp(`## ${title}\\s*\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  if (!m) return [];
  try { return JSON.parse(m[1]); } catch { return []; }
};

/** Split a talk note back into the pieces the reader needs. */
export function parseTalkNote(note) {
  const body = note.body;

  // `## Transcript` is the verbatim layer and stays the source of truth; `## Transcript
  // (reviewed)` is the optional corrected layer. Both headings are matched exactly, so
  // the reviewed section is never swallowed into the verbatim one.
  const verbatim = section(body, 'Transcript');
  const reviewed = section(body, 'Transcript (reviewed)');

  return {
    ...note.frontmatter,
    paragraphs: verbatim === null ? toParagraphs(body) : toParagraphs(verbatim),
    reviewed: reviewed === null ? null : toParagraphs(reviewed),
    corrections: fencedJson(body, 'Corrections'),
    languageNotes: section(body, 'Language notes') || '',
    cues: fencedJson(body, 'Cues'),
    rel: note.rel,
  };
}

/**
 * Write (or replace) the corrected layer beside the verbatim transcript. The verbatim
 * text is never touched: it is what she actually heard, and the cue timings key off it.
 * Paragraph count must match or click-to-seek would drift against the audio.
 */
export function writeReviewedLayer(id, { paragraphs, corrections = [], languageNotes = '' }) {
  const note = findTalkById(id);
  if (!note) throw new Error(`No talk ${id}`);

  const verbatim = parseTalkNote(note).paragraphs;
  if (!Array.isArray(paragraphs) || paragraphs.length !== verbatim.length) {
    throw new Error(
      `Reviewed layer has ${paragraphs?.length ?? 0} paragraphs, verbatim has ${verbatim.length} — cue timings would drift`,
    );
  }

  let body = note.body;
  for (const title of ['Transcript (reviewed)', 'Corrections', 'Language notes']) {
    body = dropSection(body, title);
  }

  const block = [
    '## Transcript (reviewed)\n',
    paragraphs.join('\n\n'),
    '\n\n## Corrections\n',
    '```json',
    JSON.stringify(corrections),
    '```\n',
    languageNotes ? `\n## Language notes\n\n${languageNotes.trim()}\n` : '',
  ].join('\n');

  const anchor = body.search(/^## Speech craft[ \t]*$/m);
  body = anchor === -1
    ? `${body.trimEnd()}\n\n${block}`
    : `${body.slice(0, anchor)}${block}\n${body.slice(anchor)}`;

  writeNote(note.path, { ...note.frontmatter, reviewed_on: today() }, body);
  return { id, paragraphs: paragraphs.length, corrections: corrections.length };
}

// -------------------------------------------------------------- vocabulary

export const vocabPath = (word) => vaultPath(DIRS.vocab, `${slugify(word)}.md`);

export function cardToNote(card, meta = {}) {
  const frontmatter = {
    word: card.lemma,
    type: 'vocab',
    surface: card.inflected || card.lemma,
    ipa_uk: card.ipaUK || '',
    ipa_us: card.ipaUS || '',
    ipa: card.ipa || '',
    audio_uk: card.audioUK,
    audio_us: card.audioUS,
    pos: card.pos,
    zh: (card.zh || '').split('\n')[0],
    exam_tags: card.tags,
    collins: card.collins,
    frq: card.frq,
    band: card.band,
    status: 'new',
    talk: meta.talkId || '',
    talk_title: meta.talkTitle || '',
    context: card.context || '',
    times_tested: 0,
    times_correct: 0,
    last_reviewed: '',
    added: today(),
    notion_page: '',
  };

  const zhLines = (card.zh || '').split('\n').filter(Boolean);
  const body = [
    card.zh ? `## 中文\n\n${zhLines.map((l) => `- ${l}`).join('\n')}\n` : '',
    card.englishDefs?.length
      ? `## Definition\n\n${card.englishDefs.map((d) => `- *${d.pos}* — ${d.text}`).join('\n')}\n`
      : '',
    '## Examples\n',
    card.examples.map((e) => `- ${e.text}${e.zh ? `\n  - ${e.zh}` : ''}\n  - <sup>${e.source}</sup>`).join('\n'),
    '\n',
    `## Hear it\n\n[Real speakers saying "${card.lemma}"](${card.youglish})`,
    meta.talkId ? `\n## Source\n\nFrom [[${meta.talkTitle}]] (\`${meta.talkId}\`)` : '',
  ].filter(Boolean).join('\n');

  return { frontmatter, body };
}

export function saveWord(card, meta = {}) {
  const abs = vocabPath(card.lemma);
  const existing = readNote(abs);
  if (existing) return { path: abs, created: false, frontmatter: existing.frontmatter };
  const { frontmatter, body } = cardToNote(card, meta);
  writeNote(abs, frontmatter, body);
  return { path: abs, created: true, frontmatter };
}

export function allWords() {
  return listNotes(DIRS.vocab)
    .map((abs) => {
      const note = readNote(abs);
      return note ? { ...note.frontmatter, path: abs, rel: note.rel } : null;
    })
    .filter(Boolean);
}

export function allTalks() {
  return listNotes(DIRS.talks)
    .map((abs) => {
      const note = readNote(abs);
      return note ? { ...note.frontmatter, path: abs, rel: note.rel } : null;
    })
    .filter((t) => t && t.type === 'talk');
}
