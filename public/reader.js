import { displayName, knownLabels, nonLexicalRanges, speakerLabel } from './labels.js';
import { api, el, fmtDuration, mountChrome, playAudio, titleCase, toast } from './common.js';

mountChrome('reader');

const talkId = location.pathname.split('/').filter(Boolean).pop();
const panel = document.getElementById('panel');
const cardBody = document.getElementById('cardBody');

let talk = null;
let saved = new Set();
let lemmas = {};
let currentCard = null;

/**
 * Which layer she is reading. `delivered` is the verbatim transcript — what the speaker
 * actually said. `reviewed` is the corrected layer, and is the default when one exists,
 * so she reads correct English unless she asks to hear the real delivery.
 */
/**
 * One column, always the corrected text. What the speaker actually said is not a second
 * column any more — it lives folded inside each paragraph's notes, opened from the gutter.
 */
const hasReviewed = () => Array.isArray(talk?.reviewed) && talk.reviewed.length > 0;
const readingParagraphs = () => (hasReviewed() ? talk.reviewed : talk.paragraphs);

/** Derived, never stored — the markers are already in the text and cannot drift from it. */
let labelCache = null;
const speakerLabels = () => (labelCache ??= knownLabels(talk.paragraphs || []));

/** Surface form → dictionary headword, so "trilobites" resolves to the saved "trilobite". */
const lemmaOf = (token) => lemmas[token] || token;

// --------------------------------------------------------------- transcript

/** The sentence containing a word — this is what makes a saved word memorable later. */
function sentenceAround(paragraph, wordIndex) {
  const sentences = paragraph.match(/[^.!?]+[.!?]*/g) || [paragraph];
  let cursor = 0;
  for (const s of sentences) {
    const start = paragraph.indexOf(s, cursor);
    if (wordIndex >= start && wordIndex < start + s.length) return s.trim();
    cursor = start + s.length;
  }
  return paragraph.trim();
}

/** How each correction type is labelled in the notes strip. */
const FIX_LABEL = { g: 'Grammar', t: 'Transcript', q: 'Judgment', k: 'Keep' };

/**
 * Corrections whose replacement text can be located verbatim in a paragraph, as
 * non-overlapping ranges. Anything that cannot be pinned to a span — a reordered clause,
 * a craft note with no literal replacement — falls through to the notes strip instead of
 * being highlighted in the wrong place.
 */
function fixRanges(text, list, key = 'now') {
  const found = [];
  for (const c of list) {
    if (!c.was || !c[key]) continue;
    const at = text.indexOf(c[key]);
    if (at === -1) continue;
    found.push({ start: at, end: at + c[key].length, c });
  }
  found.sort((a, b) => a.start - b.start);
  return found.filter((r, i, all) => i === 0 || r.start >= all[i - 1].end);
}

/**
 * The reading column. Two independent visual channels: a saved word gets a warm gold fill
 * (`.w.saved`), a correction gets a cool hairline (`.fix`). Because one is a fill and the
 * other is a line, a saved word sitting inside a correction still reads as both.
 */
function paintReading(para, pi, ranges) {
  const frag = document.createDocumentFragment();
  const parts = para.split(/([A-Za-z][A-Za-z'’-]*)/);
  const labels = speakerLabels();
  const turn = speakerLabel(para, labels);
  const dead = nonLexicalRanges(para, labels);
  const inDead = (at) => dead.some((r) => at >= r.start && at < r.end);
  const isTurn = (at) => turn && at < turn.end;
  let offset = 0;
  let mark = null;

  for (const part of parts) {
    if (!part) continue;
    const range = ranges.find((r) => offset >= r.start && offset < r.end);
    if (!range) {
      mark = null;
    } else if (!mark || mark.dataset.s !== String(range.start)) {
      mark = el('span', {
        class: 'fix', 'data-s': String(range.start),
        title: `was: ${range.c.was}\n\n${range.c.why}`,
      });
      frag.appendChild(mark);
    }
    const host = mark || frag;

    if (/^[A-Za-z]/.test(part) && part.length > 1 && !inDead(offset) && !isTurn(offset)) {
      const clean = part.toLowerCase().replace(/[’']s$/, '');
      const lemma = lemmaOf(clean);
      const span = el('span', {
        class: 'w', 'data-w': clean, 'data-lemma': lemma, 'data-p': pi, 'data-o': offset,
      }, part);
      if (saved.has(lemma)) span.classList.add('saved');
      host.appendChild(span);
    } else if (isTurn(offset)) {
      host.appendChild(el('span', {
        class: 'who', 'data-who': displayName(turn.who, labels), title: displayName(turn.who, labels),
      }, part));
    } else if (inDead(offset)) {
      host.appendChild(el('span', { class: 'stage' }, part));
    } else {
      host.appendChild(document.createTextNode(part));
    }
    offset += part.length;
  }
  return frag;
}

function renderTranscript() {
  const box = document.getElementById('transcript');
  box.replaceChildren();

  const reading = readingParagraphs();
  const corrections = hasReviewed() ? (talk.corrections || []) : [];

  reading.forEach((para, pi) => {
    const mine = corrections.filter((c) => c.p === pi);
    const fixes = mine.filter((c) => c.type !== 'k');
    const craft = mine.filter((c) => c.type === 'k');
    const row = el('div', { class: 'prow' });

    const gutter = el('div', { class: 'gutter' });
    if (fixes.length) {
      gutter.append(el('button', {
        class: 'gtick g', type: 'button',
        title: `${fixes.length} correction${fixes.length === 1 ? '' : 's'} — click to see what changed`,
        'aria-label': `Show ${fixes.length} corrections in paragraph ${pi + 1}`,
        onclick: () => row.classList.toggle('open'),
      }, String(fixes.length)));
    }
    if (craft.length) {
      gutter.append(el('button', {
        class: 'gtick k', type: 'button',
        title: `${craft.length} line${craft.length === 1 ? '' : 's'} worth reciting`,
        'aria-label': `Show ${craft.length} craft notes in paragraph ${pi + 1}`,
        onclick: () => row.classList.toggle('open'),
      }, '✦'));
    }

    row.append(gutter);
    row.append(el('div', { class: 'corr' }, paintReading(para, pi, fixRanges(para, fixes))));

    if (mine.length) {
      row.append(el('div', { class: 'notes' },
        ...mine.map((c) => el('div', { class: `nrow${c.type === 'k' ? ' k' : ''}` },
          el('span', { class: 'ntag' }, FIX_LABEL[c.type] || 'Fix'),
          c.was ? el('span', { class: 'nwas' }, c.was) : null,
          c.was ? el('span', { class: 'narr' }, '→') : null,
          el('span', { class: 'nnow' }, c.now),
          el('span', { class: 'nwhy' }, c.why),
        )),
      ));
    }
    box.append(row);
  });

  if (talk.languageNotes) {
    box.append(el('details', { class: 'langnotes' },
      el('summary', {}, 'Language notes — the patterns behind these corrections'),
      el('div', { class: 'langnotes-body', html: mdLite(talk.languageNotes) }),
    ));
  }
}

/** Just enough Markdown for the language-notes block: bold, inline code, paragraphs. */
function mdLite(text) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(text)
    .split(/\n{2,}/)
    .map((block) => `<p>${block
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, ' ')}</p>`)
    .join('');
}

/**
 * An unreviewed talk offers the pass instead of a legend. The button is the only thing standing
 * between a raw TED transcript and her reading it aloud as if it were correct English.
 */
function renderPolish() {
  if (hasReviewed()) return null;
  const btn = el('button', { class: 'btn', type: 'button' }, 'Polish this transcript');
  const note = el('span', { class: 'sub' }, 'Not yet reviewed — TED transcripts carry real errors.');
  const box = el('div', { class: 'layers' }, el('div', { class: 'legend' }, btn, note));

  wirePolish(btn, note, 'Polish this transcript');
  return box;
}

/**
 * Re-running the pass on a talk that already has a layer.
 *
 * The server refuses this without ?force=1, because a reviewed layer may have been written by hand
 * and a stray click must not spend it. So the affordance exists but asks twice — the first click
 * only turns the button into the warning.
 */
function renderRepolish() {
  const btn = el('button', { class: 'btn sm ghost', type: 'button' }, 'Re-polish');
  const note = el('span', { class: 'sub' }, '');
  btn.onclick = () => {
    btn.replaceChildren(document.createTextNode('Replace the current review?'));
    btn.classList.remove('ghost');
    note.textContent = 'This discards the existing corrections and craft notes.';
    wirePolish(btn, note, 'Re-polish', '?force=1');
  };
  return el('span', { class: 'key' }, btn, note);
}

/** Shared click behaviour for both entry points into the pass. */
function wirePolish(btn, note, label, query = '') {
  btn.onclick = async () => {
    btn.disabled = true;
    btn.replaceChildren(el('span', { class: 'spinner' }), document.createTextNode(' Reading it through…'));
    note.textContent = 'This takes a minute — Claude is reading the whole talk.';
    try {
      const r = await api.post(`/api/talk/${talkId}/polish${query}`, {});
      toast(`${r.fixes} corrections, ${r.craft} lines worth reciting`);
      location.reload();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      note.textContent = err.message;
    }
  };
}

/** No layout modes any more — just the key to what the marks mean. */
function renderControls() {
  if (!hasReviewed()) return renderPolish();
  const all = talk.corrections || [];
  const n = all.filter((c) => c.type !== 'k').length;
  const k = all.filter((c) => c.type === 'k').length;

  return el('div', { class: 'layers' },
    el('div', { class: 'legend' },
      el('span', { class: 'key' }, el('span', { class: 'w saved' }, 'a word'), ' you saved'),
      el('span', { class: 'key' }, el('span', { class: 'fix' }, 'a phrase'), ' that was corrected'),
      el('span', { class: 'key' }, el('span', { class: 'gtick g static' }, String(n)), ' click to see what changed'),
      el('span', { class: 'key' }, el('span', { class: 'gtick k static' }, '✦'), ` ${k} line${k === 1 ? '' : 's'} worth reciting`),
      renderRepolish(),
    ),
  );
}

function buildHead() {
  return [
    el('h1', {}, talk.title),
    el('div', { class: 'by' },
      [talk.speaker, talk.source, fmtDuration(talk.duration), `${talk.words.toLocaleString()} words`, talk.difficulty]
        .filter(Boolean).join(' · ')),
    el('div', { style: 'margin-top:.9rem; display:flex; gap:.4rem; flex-wrap:wrap' },
      ...(String(talk.topics || '').split(',').map((s) => s.trim()).filter(Boolean)
        .map((t) => el('span', { class: 'chip' }, titleCase(t)))),
      talk.url && !talk.url.startsWith('pasted:')
        ? el('a', { class: 'chip', href: talk.url, target: '_blank', rel: 'noopener' }, 'Watch ↗') : null,
    ),
    renderControls(),
    el('p', { class: 'sub', style: 'margin-top:1rem' }, 'Click any word to look it up. Select a phrase for a whole expression.'),
  ];
}

// -------------------------------------------------------------------- card

function renderCard(card, { loading = false } = {}) {
  cardBody.replaceChildren();
  if (loading) {
    cardBody.append(el('div', { style: 'padding:2rem;text-align:center' },
      el('span', { class: 'spinner' }), el('div', { class: 'sub', style: 'margin-top:.8rem' }, 'Looking it up…')));
    return;
  }

  currentCard = card;
  const head = el('div', {},
    el('div', { class: 'wordhead' }, card.lemma,
      card.inflected ? el('span', { class: 'infl' }, `  ← ${card.inflected}`) : null),
  );

  // Only claim an accent when the source actually distinguishes one. Otherwise show a
  // single transcription and fall back to the browser voice.
  const phon = el('div', { class: 'phon' });
  const accents = [['UK', card.ipaUK, card.audioUK], ['US', card.ipaUS, card.audioUS]]
    .filter(([, ipa, audio]) => ipa || audio);
  if (accents.length) {
    for (const [label, ipa, audio] of accents) {
      phon.append(el('button', {
        onclick: () => playAudio(audio, card.lemma, label.toLowerCase()),
        title: audio ? 'Play recording' : 'Speak',
      }, el('span', { class: 'lbl' }, label), ipa || '▶', el('span', {}, '🔊')));
    }
  } else {
    // No recording either way — offer both accents through the natural TTS voice.
    for (const label of ['UK', 'US']) {
      phon.append(el('button', {
        onclick: () => playAudio('', card.lemma, label.toLowerCase()), title: 'Speak',
      }, el('span', { class: 'lbl' }, label), card.ipa || '▶', el('span', {}, '🔊')));
    }
  }

  const tags = el('div', { class: 'tagrow' },
    card.band ? el('span', { class: 'chip' }, card.band) : null,
    ...card.tags.map((t) => el('span', { class: 'chip gold' }, t)),
    card.collins ? el('span', { class: 'chip' }, '★'.repeat(card.collins)) : null,
  );

  cardBody.append(head, phon);
  if (card.zh) {
    cardBody.append(el('div', { class: 'zh' }, ...card.zh.split('\n').map((line) => el('div', {}, line))));
  }
  cardBody.append(tags);

  // What the word means *in this speech* — the sense that is actually in play, plus the
  // phrase it forms. Marked as a reading, because it is inferred rather than looked up.
  if (card.context && (card.sense?.english || card.collocation)) {
    cardBody.append(el('div', { class: 'sect' }, 'In this speech'));
    const box = el('div', { class: 'incontext' });
    if (card.collocation) {
      box.append(el('div', { class: 'colloc' }, card.collocation,
        el('span', { class: 'collocnote' }, ' — the phrase used here')));
    }
    if (card.sense?.english) {
      box.append(el('p', {}, el('i', {}, `${card.sense.english.pos} `), card.sense.english.text));
      if (card.sense.zh) box.append(el('div', { class: 'zhline' }, card.sense.zh));
      box.append(el('div', { class: 'src' },
        card.sense.phrasalUnresolved
          ? `Base sense shown — as a phrase, “${card.collocation}” often means something else`
          : card.sense.confident ? 'Best match for this sentence' : 'Likely sense — check the full list below',
        card.sense.otherSenses ? ` · ${card.sense.otherSenses} other sense${card.sense.otherSenses > 1 ? 's' : ''}` : ''));
    }
    cardBody.append(box);
  }

  if (card.englishDefs?.length) {
    cardBody.append(el('div', { class: 'sect' }, 'All senses'));
    for (const d of card.englishDefs) {
      const isChosen = card.sense?.english && d.text === card.sense.english.text;
      cardBody.append(el('div', { class: `ex ${isChosen ? 'chosen' : ''}` },
        el('p', {}, el('i', {}, `${d.pos} `), d.text)));
    }
  }

  if (card.examples.length) {
    cardBody.append(el('div', { class: 'sect' }, `How it's used · ${card.examples.length} sourced examples`));
    for (const ex of card.examples) {
      // Every example names where it came from, and links to the original where one exists.
      const attribution = el('div', { class: 'src' });
      if (ex.sourceUrl) {
        attribution.append(el('a', { href: ex.sourceUrl, target: '_blank', rel: 'noopener' }, ex.source));
      } else {
        attribution.append(el('span', {}, ex.source));
      }
      if (ex.sourceDetail) attribution.append(el('span', {}, ` · ${ex.sourceDetail}`));
      if (ex.licence) attribution.append(el('span', { class: 'lic' }, ` · ${ex.licence}`));

      cardBody.append(el('div', { class: `ex ${ex.fromTalk ? 'fromtalk' : ''}` },
        el('p', {}, ex.text),
        ex.zh ? el('div', { class: 'zhline' }, ex.zh) : null,
        attribution,
      ));
    }
  }

  cardBody.append(el('div', { class: 'sect' }, 'Hear real speakers'),
    el('a', { href: card.youglish, target: '_blank', rel: 'noopener' }, `Watch people say “${card.lemma}” →`));

  const actions = el('div', { class: 'actions' });
  if (card.saved) {
    actions.append(
      el('button', { class: 'btn ghost', onclick: () => setStatus(card.lemma, 'known') }, 'I know this'),
      el('button', { class: 'btn ghost', onclick: () => removeWord(card.lemma) }, 'Remove'),
    );
  } else {
    actions.append(el('button', { class: 'btn gold', onclick: () => saveWord(card) }, '＋ Save to my words'));
  }
  cardBody.append(actions);
}

function openPanel() { panel.classList.add('open'); }
function closePanel() { panel.classList.remove('open'); }

// ------------------------------------------------------------------ actions

let pendingContext = null;

async function lookupWord(word, context, contextRef) {
  pendingContext = { context, contextRef };
  openPanel();
  renderCard(null, { loading: true });
  try {
    const card = await api.post('/api/lookup', {
      word, context, contextRef, talkTitle: talk.title, talkUrl: talk.url,
    });
    renderCard(card);
  } catch (err) {
    cardBody.replaceChildren(el('div', { class: 'empty' }, err.message));
  }
}

async function saveWord(card) {
  try {
    const r = await api.post('/api/word', {
      word: card.lemma,
      context: pendingContext?.context || card.context,
      contextRef: pendingContext?.contextRef,
      talkId,
      talkTitle: talk.title,
      talkUrl: talk.url,
    });
    saved.add(r.word);
    // Every surface form resolving to this lemma turns gold, not just the one clicked.
    document.querySelectorAll('.transcript .w').forEach((span) => {
      if (span.dataset.lemma === r.word) span.classList.add('saved');
    });
    renderCard({ ...card, saved: true });
    toast(`“${r.word}” saved to your vault`);
  } catch (err) {
    toast(err.message);
  }
}

async function setStatus(word, status) {
  await api.post('/api/word-status', { word, status });
  toast(`Marked “${word}” as ${status}`);
  closePanel();
}

async function removeWord(word) {
  await api.post('/api/word-delete', { word });
  saved.delete(word);
  document.querySelectorAll('.transcript .w').forEach((s) => {
    if (s.dataset.lemma === word) s.classList.remove('saved');
  });
  toast(`Removed “${word}”`);
  closePanel();
}

// ------------------------------------------------------------------- events

/**
 * The example sentence saved with a word has to be one that was really said, so it is
 * taken from the verbatim layer even when she is reading the corrected one. If the word
 * only exists in the corrected text, the sentence is labelled rather than passed off as
 * a quote from the talk.
 */
function sourcedContext(pi, lemma, shown) {
  if (!hasReviewed()) return { context: shown, ref: `para ${pi + 1}` };
  const verbatim = talk.paragraphs[pi] || '';
  const sentences = verbatim.match(/[^.!?]+[.!?]*/g) || [verbatim];
  const hit = sentences.find((sent) => new RegExp(`\\b${lemma.replace(/[^A-Za-z'’-]/g, '')}`, 'i').test(sent));
  return hit
    ? { context: hit.trim(), ref: `para ${pi + 1}` }
    : { context: shown, ref: `para ${pi + 1} (corrected)` };
}

document.getElementById('transcript').addEventListener('click', (e) => {
  const selection = String(window.getSelection() || '').trim();
  const span = e.target.closest('.w');
  const paras = readingParagraphs();

  // A multi-word selection means she wants the phrase, not the word under the cursor.
  if (selection && selection.includes(' ') && selection.split(/\s+/).length <= 4) {
    const pi = Number(span?.dataset.p ?? 0);
    const phrase = selection.replace(/[^A-Za-z'’ -]/g, '').trim();
    const { context, ref } = sourcedContext(pi, phrase.split(/\s+/)[0] || phrase, paras[pi] || '');
    return lookupWord(phrase, context, ref);
  }
  if (!span) return;

  const pi = Number(span.dataset.p);
  const shown = sentenceAround(paras[pi], Number(span.dataset.o));
  const { context, ref } = sourcedContext(pi, span.dataset.w, shown);
  lookupWord(span.dataset.w, context, ref);
});

document.getElementById('closePanel').addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

window.addEventListener('scroll', () => {
  const max = document.body.scrollHeight - innerHeight;
  document.getElementById('progress').style.width = `${max > 0 ? (scrollY / max) * 100 : 0}%`;
}, { passive: true });

// --------------------------------------------------------------------- boot

try {
  const data = await api.get(`/api/talk/${talkId}`);
  talk = data.talk;
  saved = new Set(data.savedWords);
  lemmas = data.lemmas || {};

  document.title = `${talk.title} · Speech Partner`;
  // replaceChildren has no opinion about null the way el() does — it renders the word.
  document.getElementById('head').replaceChildren(...buildHead().filter(Boolean));
  renderTranscript();
} catch (err) {
  document.getElementById('head').replaceChildren(el('div', { class: 'empty' }, err.message));
}
