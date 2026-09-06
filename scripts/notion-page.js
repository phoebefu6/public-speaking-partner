// Emit the Notion row for one talk, ready for notion-create-pages.
//
//   node scripts/notion-page.js TALK-0001
//
// Prints JSON: { properties, content }. `properties` matches the Speeches data source
// schema; `content` is Notion-flavored Markdown for the page body.
//
// Word cards only, with a link back to the source. The full transcript is deliberately
// NOT copied: it is a third-party copyrighted work, the quoted sentences are what get
// reviewed on a phone anyway, and short excerpts with attribution are the defensible form.

import { allWords, findTalkById, parseTalkNote } from '../lib/library.js';
import { lemmatize } from '../lib/dict.js';

// Options the Category multi-select already has. Anything else is passed through
// title-cased; Notion accepts new options on write.
const KEEP_UPPER = new Set(['AI', 'TED', 'UK', 'US']);
const titleCase = (s) =>
  String(s).split(/\s+/).map((w) =>
    KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).join(' ');

const id = process.argv[2];
if (!id) {
  console.error('usage: node scripts/notion-page.js <TALK-ID>');
  process.exit(1);
}

const note = findTalkById(id);
if (!note) {
  console.error(`No talk with id ${id}`);
  process.exit(1);
}

const talk = parseTalkNote(note);
const words = allWords()
  .filter((w) => w.talk === id)
  .sort((a, b) => String(a.word).localeCompare(String(b.word)));

const mastered = words.filter((w) => ['known', 'retired'].includes(String(w.status))).length;
const topics = String(talk.topics || '')
  .split(',').map((t) => t.trim()).filter(Boolean).map(titleCase);

const sourceLink = talk.url && !String(talk.url).startsWith('pasted:')
  ? (talk.source === 'TED' ? `${talk.url}/transcript` : talk.url)
  : '';

// ------------------------------------------------------------------ body

const body = [];
if (sourceLink) body.push(`[Watch the talk / read the full transcript](${sourceLink})`, '');
body.push(`## ${words.length} word${words.length === 1 ? '' : 's'} to own`, '');

for (const w of words) {
  const ipa = w.ipa_us || w.ipa_uk || w.ipa || '';
  body.push(`### ${w.word}${ipa ? `  ${ipa}` : ''}`);

  // Only render the tag code-span when tags exist — an empty `` reads as a bug.
  const tags = String(w.exam_tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  body.push(`**${w.zh}**${tags.length ? `  \`${tags.join(' · ')}\`` : ''}`, '');
  if (w.context) body.push(`> ${w.context}`, '');
}

body.push('---', '');

// Full transcript, so the page is readable on its own during a commute. Saved words are
// bolded in place — she can see what she has already claimed without leaving the page.
const savedLemmas = new Set(words.map((w) => String(w.word).toLowerCase()));
const lemmaCache = new Map();
const bold = (para) =>
  para.replace(/[A-Za-z][A-Za-z'’-]*/g, (tok) => {
    const clean = tok.toLowerCase().replace(/[’']s$/, '');
    if (!lemmaCache.has(clean)) lemmaCache.set(clean, lemmatize(clean));
    // Match inflected surfaces too — "ushered" is bolded because "usher" is saved.
    return savedLemmas.has(clean) || savedLemmas.has(lemmaCache.get(clean)) ? `**${tok}**` : tok;
  });

body.push('## Transcript', '');
for (const para of talk.paragraphs) body.push(bold(para), '');

body.push('---', '', `*Transcript reproduced for personal study. Source: ${talk.speaker || talk.source}${sourceLink ? ` — ${sourceLink}` : ''}.*`);

// ------------------------------------------------------------ properties

const properties = {
  Talk: talk.title,
  Speaker: talk.speaker || '',
  Category: topics,
  'Highlighted Words': words.length,
  Mastered: mastered,
  Source: talk.source,
  Level: talk.difficulty || '',
  Minutes: talk.duration ? Math.round(talk.duration / 60) : 0,
  Status: talk.status ? talk.status.charAt(0).toUpperCase() + talk.status.slice(1) : 'Inbox',
  'Talk ID': id,
  'date:Added:start': talk.added || new Date().toISOString().slice(0, 10),
};
if (sourceLink) properties.Link = talk.url;
// Only set the talk's date when we actually know it. Deriving "2024-01-01" from the
// folder shard would put a date in her database that is simply false.
if (/^\d{4}-\d{2}-\d{2}$/.test(String(talk.date || ''))) {
  properties['date:Date:start'] = talk.date;
}

console.log(JSON.stringify({
  dataSourceId: 'f89753bf-7e6f-419c-af03-aa37272abb93',
  properties,
  content: body.join('\n'),
}, null, 2));
