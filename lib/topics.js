// Topic tagging.
//
// TED hands us topics; YouTube and pasted transcripts hand us nothing, and a talk with no topics
// arrives in Notion with an empty Category — invisible to every filter she has built there.
//
// The vocabulary is taken from the topics already in the vault rather than from a list written
// here, so the tags stay a description of her library instead of drifting into a taxonomy nobody
// maintains. A talk may add a genuinely new term, but only sparingly: a multi-select where every
// row invents its own labels is the same as no labels at all.

import * as lib from './library.js';
import { patchFrontmatter } from './vault.js';
import { call } from './polish.js';

const SYSTEM = `You tag talk transcripts with topics for a personal study library.

Return ONLY a JSON object, no prose and no code fences:
{"topics": ["Topic One", "Topic Two"]}

Rules:
- 3 to 6 topics. Fewer is better than padding.
- STRONGLY prefer terms from the existing vocabulary you are given — matching an existing term is
  what makes the library filterable. Reuse the exact spelling and capitalisation.
- You may introduce at most 2 new terms, and only when nothing existing comes close. A new term must
  be broad enough that another talk could plausibly share it. Never invent a term that describes
  only this one talk.
- Title Case. No hashtags, no punctuation, no multi-word phrases longer than three words.
- Tag what the talk is ABOUT, not what it mentions in passing and not the format of the talk.`;

/** Every topic already in use, most-used first — the vocabulary a new talk should join. */
export function vocabulary() {
  const counts = new Map();
  for (const t of lib.allTalks()) {
    for (const name0 of t.topics || []) {
      const name = String(name0).trim();
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/** Enough of a talk to classify it, without shipping ten thousand words to do it. */
function sample(paragraphs, limit = 1200) {
  const out = [];
  let words = 0;
  for (const p of paragraphs) {
    out.push(p);
    words += p.split(/\s+/).length;
    if (words >= limit) break;
  }
  return out.join('\n\n');
}

export async function suggestTopics({ title, speaker, source, paragraphs }) {
  const known = vocabulary();
  const user = `Existing vocabulary (prefer these): ${known.join(', ') || '(the library is empty)'}\n\n`
    + `Talk: "${title}"${speaker ? ` — ${speaker}` : ''} (${source}).\n\n${sample(paragraphs)}`;

  const { data } = await call(SYSTEM, user, {
    tool: {
      name: 'submit_topics',
      description: 'Submit the topics for this talk.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { topics: { type: 'array', items: { type: 'string' } } },
        required: ['topics'],
        additionalProperties: false,
      },
    },
    shape: 'Return ONLY {"topics": ["Topic One", "Topic Two"]} — no prose, no code fences.',
  });
  const topics = (data.topics || [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, 6);
  if (!topics.length) throw new Error('Claude returned no topics');

  // Fold near-misses back onto the vocabulary — "AI" and "Ai" must not become two options.
  const byLower = new Map(known.map((t) => [t.toLowerCase(), t]));
  return topics.map((t) => byLower.get(t.toLowerCase()) || t);
}

/** Tag one talk in place and report what changed. Never overwrites topics that already exist. */
export async function tagTalk(id, { force = false } = {}) {
  const note = lib.findTalkById(id);
  if (!note) throw new Error(`No talk ${id}`);
  const existing = note.frontmatter.topics || [];
  if (existing.length && !force) return { id, topics: existing, changed: false };

  const talk = lib.parseTalkNote(note);
  const topics = await suggestTopics({
    title: note.frontmatter.title,
    speaker: note.frontmatter.speaker,
    source: note.frontmatter.source,
    paragraphs: talk.reviewed?.length ? talk.reviewed : talk.paragraphs,
  });
  patchFrontmatter(note.path, { topics });
  return { id, topics, changed: true, was: existing };
}
