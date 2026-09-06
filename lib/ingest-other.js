// YouTube and pasted-text ingestion.
//
// YouTube captions come via yt-dlp because there is no stable public captions API.
// Pasted text is the escape hatch that makes every other source workable today —
// a podcast transcript copied from a show's site lands here.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { countWords, normalizePunctuation, splitOnTurns } from '../public/labels.js';

const run = promisify(execFile);

export const isYoutubeUrl = (url) => /^https?:\/\/(www\.|m\.)?(youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/)/i.test(url);

async function ytDlpPath() {
  for (const cmd of ['yt-dlp', path.join(os.homedir(), 'Library/Python/3.9/bin/yt-dlp'), '/opt/homebrew/bin/yt-dlp']) {
    try {
      await run(cmd, ['--version']);
      return cmd;
    } catch { /* try next */ }
  }
  throw new Error('yt-dlp not found. Install it with:  pip3 install --user yt-dlp');
}

/**
 * Drop the part of a cue that the previous cue already said.
 *
 * YouTube's rolling captions do not repeat a cue wholesale — each one carries the tail of the
 * previous cue plus one new line, so the caption scrolls. Comparing whole cues therefore matches
 * nothing and every line survives two or three times over.
 */
function dropOverlap(prevLines, lines) {
  for (let k = Math.min(prevLines.length, lines.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (prevLines[prevLines.length - k + i] !== lines[i]) { same = false; break; }
    }
    if (same) return lines.slice(k);
  }
  return lines;
}

/** VTT → plain cues, dropping the rolling-caption overlap YouTube emits. */
export function parseVtt(vtt) {
  const cues = [];
  let prev = [];
  for (const block of vtt.replace(/\r/g, '').split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const timing = lines.find((l) => l.includes('-->'));
    if (!timing) continue;

    const spoken = lines
      .slice(lines.indexOf(timing) + 1)
      .map((l) => l.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!spoken.length) continue;

    const fresh = dropOverlap(prev, spoken);
    prev = spoken;
    if (!fresh.length) continue;

    const text = fresh.join(' ').trim();
    if (!text) continue;
    const [h, m, s] = timing.split('-->')[0].trim().split(':');
    cues.push({
      time: Math.round((Number(h) * 3600 + Number(m) * 60 + parseFloat(s)) * 1000),
      text: normalizePunctuation(text),
    });
  }
  return cues;
}

/** Group cues into readable paragraphs — roughly 90 words, broken at sentence ends. */
function cuesToParagraphs(cues) {
  const paragraphs = [];
  let buf = [];
  let count = 0;
  for (const c of cues) {
    buf.push(c.text);
    count += c.text.split(/\s+/).length;
    if (count >= 90 && /[.!?]"?$/.test(c.text)) {
      paragraphs.push(buf.join(' '));
      buf = [];
      count = 0;
    }
  }
  if (buf.length) paragraphs.push(buf.join(' '));
  return paragraphs;
}

// YouTube rotates which player clients it will serve; a client that worked last month
// starts returning "The page needs to be reloaded". Try them in order rather than
// pinning one and breaking silently later.
const PLAYER_CLIENTS = ['android', 'web_safari', 'tv', 'mweb', 'web'];

async function ytRun(bin, args, clientArgs) {
  let lastError;
  for (const client of clientArgs) {
    try {
      return await run(bin, ['--extractor-args', `youtube:player_client=${client}`, ...args],
        { maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `YouTube refused every player client. yt-dlp may be out of date — update it with:  pip3 install --user -U yt-dlp\n${lastError?.message?.slice(0, 200) || ''}`
  );
}

export async function ingestYoutube(url) {
  const bin = await ytDlpPath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-yt-'));
  try {
    const { stdout } = await ytRun(bin, ['--dump-json', '--no-warnings', url], PLAYER_CLIENTS);
    const meta = JSON.parse(stdout.slice(stdout.indexOf('{')));

    // "en" only — NOT "en.*", which also matches the ~30 machine-translated tracks
    // (en-ar, en-zh, …). Requesting all of them earns an HTTP 429 partway through.
    try {
      await ytRun(bin, [
        '--skip-download', '--write-subs', '--write-auto-subs',
        '--sub-langs', 'en,en-orig', '--sub-format', 'vtt',
        '-o', path.join(dir, 'cap.%(ext)s'), url,
      ], PLAYER_CLIENTS);
    } catch (err) {
      // A throttled or partial run still leaves a usable track on disk more often
      // than not; only surface the error if nothing landed.
      if (!fs.readdirSync(dir).some((f) => f.endsWith('.vtt'))) throw err;
    }

    // Prefer the human-authored track over the auto-generated one when both exist.
    const vtts = fs.readdirSync(dir).filter((f) => f.endsWith('.vtt'));
    const vttFile = vtts.find((f) => /\.en\.vtt$/.test(f)) || vtts[0];
    if (!vttFile) throw new Error('No English captions available for this video');

    const cues = parseVtt(fs.readFileSync(path.join(dir, vttFile), 'utf8'));
    const paragraphs = splitOnTurns(cuesToParagraphs(cues));
    if (!paragraphs.length) throw new Error('Captions were empty');

    return {
      source: 'YouTube',
      url: meta.webpage_url || url,
      title: meta.title || 'Untitled video',
      speaker: meta.uploader || meta.channel || '',
      description: (meta.description || '').slice(0, 400),
      duration: meta.duration || 0,
      recordedAt: meta.upload_date ? `${meta.upload_date.slice(0, 4)}-${meta.upload_date.slice(4, 6)}-${meta.upload_date.slice(6, 8)}` : '',
      slug: meta.id || '',
      embed: meta.id ? `https://www.youtube.com/embed/${meta.id}` : '',
      poster: meta.thumbnail || '',
      topics: (meta.tags || []).slice(0, 6),
      paragraphs,
      cues: cues.map((c, i) => ({ ...c, paragraph: Math.min(i, paragraphs.length - 1) })),
      words: countWords(paragraphs),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function ingestText({ text, title, speaker = '', sourceUrl = '' }) {
  const paragraphs = String(text)
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((p) => normalizePunctuation(p))
    .filter(Boolean);
  if (!paragraphs.length) throw new Error('No text provided');
  const turned = splitOnTurns(paragraphs);

  return {
    source: 'Pasted',
    url: sourceUrl || `pasted:${Date.now()}`,
    title: title?.trim() || paragraphs[0].slice(0, 60),
    speaker,
    description: '',
    duration: 0,
    recordedAt: '',   // Unknown. The paste date is when she found it, not when it was given.
    slug: '',
    embed: '',
    poster: '',
    topics: [],
    paragraphs: turned,
    cues: [],
    words: countWords(turned),
  };
}
