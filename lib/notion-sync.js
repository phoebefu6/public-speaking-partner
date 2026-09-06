// Push a talk from the vault into the Notion Speeches database.
//
// The app does this itself over the REST API, not through a Claude session — otherwise
// "whatever I change on the site shows up in Notion" could never be true. Needs
// NOTION_TOKEN and NOTION_DATABASE_ID in .env; without them sync is simply skipped.
//
// Blocks are built directly rather than by generating Markdown and re-parsing it: fewer
// moving parts, and no escaping surprises with 中文 or IPA brackets.

import { allWords, findTalkById, parseTalkNote } from './library.js';
import { CATEGORIES, allPhrases } from './collections.js';
import { lemmatize } from './dict.js';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

export const configured = () => Boolean(process.env.NOTION_TOKEN && process.env.NOTION_DATABASE_ID);

async function notion(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': VERSION,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${res.status}: ${data.message || 'request failed'}`);
  return data;
}

// ------------------------------------------------------------- rich text

const text = (content, annotations = {}, link = null) => ({
  type: 'text',
  text: { content: String(content).slice(0, 2000), link: link ? { url: link } : null },
  annotations,
});

/** Split a paragraph into runs, bolding the words she has already saved. */
function boldedRuns(paragraph, savedLemmas, lemmaCache) {
  const runs = [];
  let buffer = '';
  const flush = () => { if (buffer) { runs.push(text(buffer)); buffer = ''; } };

  for (const part of paragraph.split(/([A-Za-z][A-Za-z'’-]*)/)) {
    if (!part) continue;
    const clean = part.toLowerCase().replace(/[’']s$/, '');
    if (/^[A-Za-z]/.test(part)) {
      if (!lemmaCache.has(clean)) lemmaCache.set(clean, lemmatize(clean));
      if (savedLemmas.has(clean) || savedLemmas.has(lemmaCache.get(clean))) {
        flush();
        runs.push(text(part, { bold: true, color: 'orange' }));
        continue;
      }
    }
    buffer += part;
    // Notion caps a single rich-text run at 2000 characters.
    if (buffer.length > 1800) flush();
  }
  flush();
  return runs.length ? runs : [text(paragraph)];
}

const block = (type, payload) => ({ object: 'block', type, [type]: payload });
const para = (runs) => block('paragraph', { rich_text: Array.isArray(runs) ? runs : [text(runs)] });
const heading = (level, runs) => block(`heading_${level}`, { rich_text: Array.isArray(runs) ? runs : [text(runs)] });
const quote = (runs) => block('quote', { rich_text: Array.isArray(runs) ? runs : [text(runs)] });
const divider = () => block('divider', {});

// ------------------------------------------------------------ page body

/**
 * A word's example sentence is quoted verbatim from the talk, which is right for the vault
 * but wrong for Notion — she reads that page aloud. Apply the same corrections the reviewed
 * layer applies, so nothing on the page is a sentence she should not say. Returns the
 * sentence unchanged when no correction touches it.
 */
function correctedContext(talk, context) {
  if (!context || !Array.isArray(talk.corrections) || !talk.corrections.length) {
    return { text: context, changed: false };
  }
  let out = String(context);
  for (const c of talk.corrections) {
    if (!c.was || !c.now || c.type === 'k') continue;
    if (out.includes(c.was)) out = out.split(c.was).join(c.now);
  }
  return { text: out, changed: out !== context };
}

/**
 * The Notion page is the read-aloud surface: the corrected transcript only, never the
 * verbatim one. The original stays on the local site, where the side-by-side view exists
 * to study grammar against.
 *
 * Order is deliberate and she set it: the article first, because that is what she opens the
 * page to do. Then the lines to recite. The word list comes last — it is reference, not
 * something you read top to bottom.
 */
function buildBlocks(talk, words, phrases, sourceLink) {
  const blocks = [];

  if (sourceLink) {
    blocks.push(para([text('Watch the talk / read the original', {}, sourceLink)]));
  }

  // ------------------------------------------------- 1. the article
  const savedLemmas = new Set(words.map((w) => String(w.word).toLowerCase()));
  const lemmaCache = new Map();
  const reading = Array.isArray(talk.reviewed) && talk.reviewed.length ? talk.reviewed : talk.paragraphs;
  const corrected = reading !== talk.paragraphs;

  blocks.push(heading(2, corrected ? 'Transcript — corrected' : 'Transcript'));
  if (corrected) {
    blocks.push(para([text(
      'Transcription errors and grammar slips fixed; fragments and repetition left exactly as spoken. Read this one aloud.',
      { italic: true, color: 'gray' },
    )]));
  }
  for (const p of reading) blocks.push(para(boldedRuns(p, savedLemmas, lemmaCache)));

  // ---------------------------------------------------- 2. lines to recite
  if (phrases.length) {
    blocks.push(divider());
    blocks.push(heading(2, `${phrases.length} line${phrases.length === 1 ? '' : 's'} to recite`));
    blocks.push(para([text(
      'Grouped by what the sentence does. The shape is the reusable part — you can build your own line to the same pattern.',
      { italic: true, color: 'gray' },
    )]));

    for (const cat of Object.keys(CATEGORIES)) {
      const rows = phrases.filter((r) => r.category === cat);
      if (!rows.length) continue;
      blocks.push(heading(3, [text(cat), text(`  ${CATEGORIES[cat].split(' — ')[1] || ''}`, { italic: true, color: 'gray' })]));
      for (const r of rows) {
        blocks.push(quote(r.text));
        blocks.push(para([text(r.why || '', { color: 'gray' })]));
      }
    }
  }

  // ---------------------------------------------------------- 3. the words
  blocks.push(divider());
  blocks.push(heading(2, `${words.length} word${words.length === 1 ? '' : 's'} to own`));

  for (const w of words) {
    const ipa = w.ipa_us || w.ipa_uk || w.ipa || '';
    blocks.push(heading(3, ipa ? [text(w.word), text(`  ${ipa}`, { code: true })] : [text(w.word)]));

    const runs = [text(w.zh || '', { bold: true })];
    const tags = String(w.exam_tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (tags.length) runs.push(text('  '), text(tags.join(' · '), { code: true }));
    if (w.status && w.status !== 'new') runs.push(text(`  ${w.status}`, { italic: true, color: 'gray' }));
    blocks.push(para(runs));

    if (w.context) {
      const { text: ctx, changed } = correctedContext(talk, w.context);
      blocks.push(quote(ctx));
      if (changed) {
        blocks.push(para([text(
          'Corrected — see the site for what was actually said.',
          { italic: true, color: 'gray' },
        )]));
      }
    }
  }

  blocks.push(divider());
  blocks.push(para([text(
    `Reproduced for personal study. Source: ${talk.speaker || talk.source}.`,
    { italic: true, color: 'gray' }
  )]));

  return blocks;
}

// ----------------------------------------------------------- properties

function buildProperties(talk, words, id, sourceLink) {
  const KEEP_UPPER = new Set(['AI', 'TED', 'UK', 'US']);
  const titleCase = (s) => String(s).split(/\s+/)
    .map((w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');

  const props = {
    Talk: { title: [text(talk.title)] },
    Speaker: { rich_text: [text(talk.speaker || '')] },
    Category: {
      multi_select: String(talk.topics || '').split(',').map((t) => t.trim()).filter(Boolean)
        .map((t) => ({ name: titleCase(t) })),
    },
    'Highlighted Words': { number: words.length },
    Mastered: { number: words.filter((w) => ['known', 'retired'].includes(String(w.status))).length },
    Source: { select: { name: talk.source } },
    Minutes: { number: talk.duration ? Math.round(talk.duration / 60) : 0 },
    'Talk ID': { rich_text: [text(id)] },
    Status: { select: { name: (talk.status || 'inbox').charAt(0).toUpperCase() + (talk.status || 'inbox').slice(1) } },
  };

  if (talk.difficulty) props.Level = { select: { name: talk.difficulty } };
  if (sourceLink) props.Link = { url: talk.url };
  if (talk.added) props.Added = { date: { start: talk.added } };
  // Only when we actually know it — never derive a plausible-looking wrong date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(talk.date || ''))) props.Date = { date: { start: talk.date } };

  return props;
}

// ----------------------------------------------------------------- sync

async function findRow(talkId) {
  const res = await notion(`/databases/${process.env.NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({ filter: { property: 'Talk ID', rich_text: { equals: talkId } }, page_size: 1 }),
  });
  return res.results?.[0]?.id || null;
}

/** Remove existing children so the page reflects the vault rather than accumulating. */
async function clearPage(pageId) {
  let cursor;
  const ids = [];
  do {
    const res = await notion(`/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    ids.push(...res.results.map((b) => b.id));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  for (const id of ids) {
    await notion(`/blocks/${id}`, { method: 'DELETE' });
  }
}

async function appendBlocks(pageId, blocks) {
  // Notion accepts at most 100 children per request.
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${pageId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({ children: blocks.slice(i, i + 100) }),
    });
  }
}

/** Create or update the Notion row for one talk. Returns { pageId, created }. */
export async function syncTalk(id) {
  if (!configured()) throw new Error('NOTION_TOKEN / NOTION_DATABASE_ID not set in .env');

  const note = findTalkById(id);
  if (!note) throw new Error(`No talk ${id}`);

  const talk = parseTalkNote(note);
  const words = allWords().filter((w) => w.talk === id)
    .sort((a, b) => String(a.word).localeCompare(String(b.word)));

  const sourceLink = talk.url && !String(talk.url).startsWith('pasted:')
    ? (talk.source === 'TED' ? `${talk.url}/transcript` : talk.url)
    : '';

  const phrases = allPhrases().filter((r) => r.talk === id);

  const properties = buildProperties(talk, words, id, sourceLink);
  const blocks = buildBlocks(talk, words, phrases, sourceLink);

  let pageId = await findRow(id);
  const created = !pageId;

  if (pageId) {
    await notion(`/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
    await clearPage(pageId);
  } else {
    const page = await notion('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: process.env.NOTION_DATABASE_ID },
        icon: { type: 'emoji', emoji: '🎙️' },
        properties,
      }),
    });
    pageId = page.id;
  }

  await appendBlocks(pageId, blocks);
  return { pageId, created, words: words.length };
}

// Coalesce bursts — saving six words in a row should produce one sync, not six.
const pending = new Map();
export function scheduleSync(id, delayMs = 4000) {
  if (!configured() || !id) return;
  clearTimeout(pending.get(id));
  pending.set(id, setTimeout(async () => {
    pending.delete(id);
    try {
      const r = await syncTalk(id);
      console.log(`notion: synced ${id} (${r.words} words)`);
    } catch (err) {
      console.error(`notion: sync failed for ${id} — ${err.message}`);
    }
  }, delayMs));
}
