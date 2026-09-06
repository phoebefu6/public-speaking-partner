// Reading the vault's phrase and vocabulary collections, and rendering the dashboard
// views over them. Counts are always derived here, never stored in a note — a stored
// count drifts the moment she edits a file in Obsidian.

import fs from 'node:fs';
import path from 'node:path';

import { DIRS, listNotes, readNote, vaultPath, writeNote } from './vault.js';

/** What each rhetorical category is for. The category is the reusable part, not the line. */
export const CATEGORIES = {
  opening: 'Opening move — how to earn attention in the first 20 seconds',
  antithesis: 'Antithesis — not X, but Y. The workhorse of persuasive speech',
  thesis: 'Thesis — the one flat sentence the whole talk is built to deliver',
  gradatio: 'Climax chain — each clause picks up the last word and climbs',
  anaphora: 'Anaphora — same opening, repeated, building pressure',
  fragment: 'Deliberate fragment — grammatically incomplete, rhetorically final',
  metaphor: 'Extended metaphor — one image carried across several verbs',
  understate: 'Understatement — the deliberate small word after a big build',
  closing: 'Closing period — the long balanced sentence that lands the ending',
};

const CATEGORY_ORDER = Object.keys(CATEGORIES);

export function allPhrases() {
  return listNotes(DIRS.phrases)
    .map((abs) => readNote(abs))
    .filter((n) => n?.frontmatter?.type === 'phrase')
    .map((n) => ({ ...n.frontmatter, path: n.path }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function allVocab() {
  return listNotes(DIRS.vocab)
    .map((abs) => readNote(abs))
    .filter((n) => n?.frontmatter?.type === 'vocab')
    .map((n) => ({ ...n.frontmatter, path: n.path }))
    .sort((a, b) => String(a.word).localeCompare(String(b.word)));
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
const link = (title) => `[[${String(title).replace(/\|/g, '')}]]`;

// ------------------------------------------------------------------ views

function recitationView(phrases) {
  const done = phrases.filter((p) => p.recite_status === 'memorised').length;
  const going = phrases.filter((p) => p.recite_status === 'practising').length;

  const lines = [
    '# Recitation',
    '',
    `*${phrases.length} lines · ${done} memorised · ${going} practising · ${phrases.length - done - going} untouched*`,
    '',
    'Sentences worth saying out loud until they are yours. Grouped by what the sentence **does**,',
    'because the shape is the reusable part — you can build your own line to the same pattern.',
    '',
  ];

  for (const cat of CATEGORY_ORDER) {
    const rows = phrases.filter((p) => p.category === cat);
    if (!rows.length) continue;
    lines.push(`## ${cat}`, '', `*${CATEGORIES[cat]}*`, '');
    lines.push('| # | Line | Speaker | Status | Said |');
    lines.push('|---|---|---|---|---|');
    for (const r of rows) {
      lines.push(`| ${r.id} | ${esc(r.text)} | ${esc(r.speaker)} | ${esc(r.recite_status)} | ${r.times_recited || 0} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function wordsView(words) {
  const byStatus = (s) => words.filter((w) => w.status === s).length;
  const lines = [
    '# Words',
    '',
    `*${words.length} words · ${byStatus('known') + byStatus('retired')} mastered · ${byStatus('new')} new*`,
    '',
    'Every word saved from a talk, with the sentence it was met in. The example sentences are',
    'quoted from the talk as delivered, so a word you learned here is a word you actually heard.',
    '',
    '| Word | IPA | 中文 | Band | Status | From | Tested |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const w of words) {
    lines.push([
      '', `**${esc(w.word)}**`, esc(w.ipa || w.ipa_uk || w.ipa_us),
      esc(w.zh), esc(w.band), esc(w.status),
      w.talk_title ? link(w.talk_title) : esc(w.talk),
      `${w.times_correct || 0}/${w.times_tested || 0}`, '',
    ].join(' | ').replace(/^ \| /, '| ').replace(/ \| $/, ' |'));
  }
  lines.push('');
  return lines.join('\n');
}

function talksView(talks, phrases, words) {
  const lines = [
    '# Talks',
    '',
    `*${talks.length} talks studied*`,
    '',
    '| ID | Talk | Speaker | Level | Reviewed | Corrections | Words | Lines |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const t of talks) {
    lines.push([
      '', esc(t.id), link(t.title), esc(t.speaker), esc(t.difficulty),
      t.reviewed_on ? esc(t.reviewed_on) : '—',
      String(t.corrections ?? 0),
      String(words.filter((w) => w.talk === t.id).length),
      String(phrases.filter((p) => p.talk === t.id).length), '',
    ].join(' | ').replace(/^ \| /, '| ').replace(/ \| $/, ' |'));
  }
  lines.push('');
  return lines.join('\n');
}

/** Rebuild every dashboard view from what is actually on disk. */
export function buildDashboards(talks) {
  const phrases = allPhrases();
  const words = allVocab();
  const dash = vaultPath(DIRS.dashboard);
  fs.mkdirSync(dash, { recursive: true });

  const files = {
    'Recitation.md': recitationView(phrases),
    'Words.md': wordsView(words),
    'Talks.md': talksView(talks, phrases, words),
  };
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dash, name), body, 'utf8');
  }
  return { phrases: phrases.length, words: words.length, talks: talks.length };
}

export { writeNote };
