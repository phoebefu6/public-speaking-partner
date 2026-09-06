// Word card assembly.
//
// Every example carries a `source` label. Nothing on a card is invented — if a source
// has nothing to say about a word, that section is simply absent. Phoebe explicitly
// chose sourced-only examples, so a card with three real examples beats one with five
// where two were made up.

import * as dict from './dict.js';
import { collocation, senseInContext } from './sense.js';

const UA = 'english-partner/0.1 (personal study tool)';
const TIMEOUT_MS = 6000;

async function getJSON(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // Network flakiness must never break a lookup — the offline half still works.
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------------------- pronunciation

async function pronunciation(word) {
  const data = await getJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  const out = { ipaUK: '', ipaUS: '', audioUK: '', audioUS: '', ipa: '', englishDefs: [], examples: [] };
  if (!Array.isArray(data)) return out;

  for (const entry of data) {
    for (const p of entry.phonetics || []) {
      const isUK = /-uk\.mp3$/i.test(p.audio || '');
      const isUS = /-us\.mp3$/i.test(p.audio || '');
      if (isUK) { out.audioUK ||= p.audio; out.ipaUK ||= p.text || ''; }
      if (isUS) { out.audioUS ||= p.audio; out.ipaUS ||= p.text || ''; }
      if (p.text) out.ipa ||= p.text;
    }
    for (const m of entry.meanings || []) {
      for (const d of m.definitions || []) {
        if (d.definition && out.englishDefs.length < 6) {
          out.englishDefs.push({ pos: m.partOfSpeech, text: d.definition });
        }
        if (d.example) {
          out.examples.push({
            text: d.example,
            source: 'Wiktionary',
            sourceDetail: entry.sourceUrls?.[0] ? 'via dictionaryapi.dev' : '',
            sourceUrl: entry.sourceUrls?.[0] || `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
            licence: entry.license?.name || 'CC BY-SA 3.0',
            licenceUrl: entry.license?.url || '',
          });
        }
      }
    }
  }
  // Deliberately not backfilling UK/US from the generic IPA — labelling one
  // transcription as both accents would be a claim the data does not support.
  return out;
}

// ------------------------------------------------------------------- corpus

async function tatoeba(word) {
  const url = `https://api.tatoeba.org/unstable/sentences?lang=eng&q=${encodeURIComponent(word)}&sort=relevance&limit=8`;
  const data = await getJSON(url);
  const out = [];
  for (const s of data?.data || []) {
    if (!s.text) continue;
    let zh = '';
    // Translations arrive as nested arrays of direct/indirect links.
    for (const group of s.translations || []) {
      for (const t of Array.isArray(group) ? group : [group]) {
        if (t?.lang === 'cmn' && t.text) { zh = t.text; break; }
      }
      if (zh) break;
    }
    out.push({
      text: s.text,
      zh,
      source: 'Tatoeba',
      // Real provenance: who contributed the sentence, under what licence, and a link
      // to the original. Attribution is the point of using a sourced corpus at all.
      sourceDetail: s.owner ? `contributed by ${s.owner}` : '',
      sourceUrl: s.id ? `https://tatoeba.org/en/sentences/show/${s.id}` : '',
      licence: s.license || 'CC BY 2.0 FR',
    });
  }
  return out;
}

/**
 * Build the full card.
 * @param {string} word      raw highlighted text
 * @param {object} opts      { context, contextRef } — the sentence from the talk, if any
 */
export async function buildCard(word, opts = {}) {
  const raw = String(word).toLowerCase().replace(/[^a-z'-]/g, '').trim();
  if (!raw) throw new Error('empty word');

  const entry = dict.lookup(raw);
  const lemma = entry?.lemma || dict.lemmatize(raw);

  const [pron, corpus] = await Promise.all([pronunciation(lemma), tatoeba(lemma)]);

  // Priority order: the talk's own sentence first (it already has a memory hook
  // attached), then real dictionary examples, then corpus sentences.
  const examples = [];
  if (opts.context) {
    examples.push({
      text: opts.context,
      source: opts.talkTitle || 'This talk',
      sourceDetail: opts.contextRef || '',
      sourceUrl: opts.talkUrl || '',
      fromTalk: true,
    });
  }
  const seen = new Set(examples.map((e) => e.text.toLowerCase()));
  for (const ex of [...pron.examples, ...corpus]) {
    const key = ex.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    examples.push(ex);
    if (examples.length >= 5) break;
  }

  const phrase = opts.context ? collocation(opts.context, raw) : '';

  return {
    word: raw,
    lemma,
    inflected: raw !== lemma ? raw : null,
    ipaUK: pron.ipaUK,
    ipaUS: pron.ipaUS,
    ipa: pron.ipa || (entry?.phonetic ? `/${entry.phonetic}/` : ''),
    audioUK: pron.audioUK,
    audioUS: pron.audioUS,
    zh: entry?.zh || '',
    pos: entry?.pos || '',
    englishDefs: pron.englishDefs,
    tags: entry?.tags || [],
    collins: entry?.collins || 0,
    frq: entry?.frq || 0,
    band: dict.bandOf(entry),
    examples,
    youglish: `https://youglish.com/pronounce/${encodeURIComponent(lemma)}/english`,
    context: opts.context || '',
    // Which of the senses is in play in the sentence she met it in, plus the phrase
    // it forms there ("ushered in"). Flagged as inferred, never asserted.
    sense: senseInContext({
      context: opts.context,
      englishDefs: pron.englishDefs,
      zh: entry?.zh || '',
      surface: raw,
      inflection: dict.inflectionOf(raw),
      phrase,
    }),
    collocation: phrase,
    known: Boolean(entry),
  };
}
