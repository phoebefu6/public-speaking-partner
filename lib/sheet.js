// Cheat sheet generation.
//
// Three exports because they serve three different moments: print for the desk,
// Markdown for the vault, Anki CSV for the commute.

import * as idx from './index-db.js';
import { readNote } from './vault.js';
import { vocabPath } from './library.js';

/** First example from a word note, so the sheet shows usage and not just a gloss. */
function firstExample(word) {
  const note = readNote(vocabPath(word));
  if (!note) return '';
  const m = note.body.match(/## Examples\s*\n\s*\n?- (.+)/);
  return m ? m[1].trim() : '';
}

function collect({ scope, value }) {
  const filters = {
    talk: { talk: value },
    status: { status: value },
    tag: { tag: value },
    all: {},
  };
  const rows = idx.queryWords(filters[scope] || {});
  return rows.map((r) => ({ ...r, example: firstExample(r.word) }));
}

const csvCell = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;

export function buildSheet({ scope = 'all', value = '', format = 'json' }) {
  const rows = collect({ scope, value });

  const label = {
    talk: `Talk ${value}`,
    status: `Status: ${value}`,
    tag: `Exam tag: ${value}`,
    all: 'All vocabulary',
  }[scope] || 'All vocabulary';

  if (format === 'csv') {
    // Anki: Front, Back, Example, Tags
    const lines = rows.map((r) =>
      [r.word, `${r.zh}${r.ipa_us ? ` ${r.ipa_us}` : ''}`, r.example || r.context || '', String(r.exam_tags || '').replace(/,/g, ' ')]
        .map(csvCell).join(',')
    );
    return { format: 'csv', mime: 'text/csv; charset=utf-8', content: ['Front,Back,Example,Tags', ...lines].join('\n') };
  }

  if (format === 'md') {
    const byTalk = new Map();
    for (const r of rows) {
      const key = r.talk_title || 'Unsorted';
      if (!byTalk.has(key)) byTalk.set(key, []);
      byTalk.get(key).push(r);
    }
    const out = [`# Cheat sheet — ${label}`, '', `*${rows.length} words · generated ${new Date().toISOString().slice(0, 10)}*`, ''];
    for (const [talk, items] of byTalk) {
      out.push(`## ${talk}`, '');
      for (const r of items) {
        out.push(`- **${r.word}** ${r.ipa_us || r.ipa_uk || ''} — ${r.zh}${r.exam_tags ? `  \`${r.exam_tags}\`` : ''}`);
        if (r.example) out.push(`  - ${r.example}`);
      }
      out.push('');
    }
    return { format: 'md', mime: 'text/markdown; charset=utf-8', content: out.join('\n') };
  }

  return { format: 'json', label, count: rows.length, rows };
}
