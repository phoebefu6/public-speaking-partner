// TED ingestion.
//
// TED renders the transcript into the page's __NEXT_DATA__ blob as paragraphs of
// timestamped cues. That gives us paragraph structure and click-to-seek timings for
// free — both of which matter for a vault aimed at studying delivery, not just words.

import { countWords, knownLabels, normalizePunctuation, speakerLabel } from '../public/labels.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export function isTedUrl(url) {
  return /^https?:\/\/(www\.)?ted\.com\/talks\//i.test(url);
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('TED page layout changed — __NEXT_DATA__ not found');
  return JSON.parse(m[1]);
}

/**
 * Cue text carries hard line-wraps from the caption file; join them into prose, and settle
 * TED's typewriter conventions while we are here. "--" is a caption-file stand-in for an em
 * dash and "don't" is the same word as "don’t" — leaving both spellings in the vault means
 * the same sentence can be stored two ways. Only the punctuation moves; no word changes.
 *
 * Editorial insertions like "[with]" are left exactly as TED wrote them. Those mark places
 * the speaker actually garbled, which is the reviewed layer's business, not ingestion's.
 */
const unwrap = normalizePunctuation;

export async function ingestTed(url) {
  const transcriptUrl = url.replace(/\/transcript.*$/, '') + '/transcript';
  const res = await fetch(transcriptUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`TED fetch failed: HTTP ${res.status}`);

  const data = extractNextData(await res.text());
  const props = data?.props?.pageProps || {};
  const video = props.videoData || {};
  const rawParagraphs = props.transcriptData?.translation?.paragraphs;

  if (!Array.isArray(rawParagraphs) || rawParagraphs.length === 0) {
    throw new Error('No English transcript available for this talk');
  }

  // TED's paragraph breaks follow the caption file, not the conversation: in a two-hander a
  // reply and the next question can land inside one paragraph. That mis-attributes every
  // line in it, so a turn marker always starts a paragraph of its own.
  const flat = [];
  for (const p of rawParagraphs) {
    let first = true;
    for (const c of p.cues || []) {
      const text = unwrap(c.text);
      if (!text) continue;
      flat.push({ time: c.time ?? 0, text, breaks: first });
      first = false;
    }
  }

  // Which markers this talk uses is decided from the cues that open TED's own paragraphs —
  // splitting on anything merely shaped like "Word:" would break at "Here's the thing:".
  const labels = knownLabels(flat.filter((c) => c.breaks).map((c) => c.text));

  const paragraphs = [];
  const cues = [];
  let current = [];
  for (const c of flat) {
    const turn = speakerLabel(c.text, labels);
    if (current.length && (c.breaks || turn)) {
      paragraphs.push(current.join(' '));
      current = [];
    }
    current.push(c.text);
    cues.push({ time: c.time, text: c.text, paragraph: paragraphs.length });
  }
  if (current.length) paragraphs.push(current.join(' '));

  const words = countWords(paragraphs);
  const topics = (video.topics?.nodes || video.topics || [])
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter(Boolean);

  return {
    source: 'TED',
    url: transcriptUrl.replace(/\/transcript$/, ''),
    title: video.title || video.slug || 'Untitled talk',
    speaker: video.presenterDisplayName || video.speakers?.nodes?.[0]?.firstname || '',
    description: (video.description || '').trim(),
    duration: video.duration || 0,
    recordedAt: (video.recordedOn || video.publishedAt || '').slice(0, 10),
    slug: video.slug || '',
    embed: video.slug ? `https://embed.ted.com/talks/${video.slug}` : '',
    poster: video.primaryImageSet?.[0]?.url || video.thumb || '',
    topics,
    paragraphs,
    cues,
    words,
  };
}
