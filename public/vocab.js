import { api, el, mountChrome, playAudio, titleCase, toast } from './common.js';

mountChrome('vocab');

const state = { q: '', status: '' };
let words = [];

const listEl = document.getElementById('list');
const studyEl = document.getElementById('study');

// -------------------------------------------------------------------- stats

async function renderStats() {
  const s = await api.get('/api/stats');
  document.getElementById('tiles').replaceChildren(
    ...[
      [s.streak, 'day streak'],
      [s.totalWords, 'words saved'],
      [s.byStatus.learning, 'learning'],
      [s.byStatus.known + s.byStatus.retired, 'mastered'],
      [s.addedThisWeek, 'added this week'],
      [s.accuracy === null ? '—' : `${s.accuracy}%`, 'test accuracy'],
    ].map(([n, l]) => el('div', { class: 'tile' }, el('div', { class: 'n' }, n), el('div', { class: 'l' }, l)))
  );

  const heat = document.getElementById('heat');
  heat.replaceChildren(...s.heatmap.map((d) => {
    const level = d.count === 0 ? 0 : d.count < 5 ? 1 : d.count < 12 ? 2 : d.count < 25 ? 3 : 4;
    return el('i', { 'data-l': level, title: `${d.date} · ${d.count} words` });
  }));
}

// --------------------------------------------------------------------- list

function row(w) {
  return el('div', { class: 'wordrow' },
    el('div', {},
      el('div', { class: 'w' }, w.word),
      el('div', { class: 'ipa' }, w.ipa_us || w.ipa_uk || ''),
    ),
    el('div', {},
      el('div', { class: 'z' }, w.zh),
      w.context ? el('div', { class: 'sub', style: 'margin:0; font-size:.82rem' }, `“${w.context}”`) : null,
      w.talk_title ? el('div', { class: 'sub', style: 'margin:0; font-size:.75rem' }, w.talk_title) : null,
    ),
    el('div', { class: 'ctl' },
      el('button', { class: 'btn sm ghost', onclick: () => playAudio(w.audio_us || w.audio_uk, w.word, 'us'), title: 'Hear it' }, '🔊'),
      el('span', { class: `chip status-${w.status}` }, titleCase(w.status)),
      w.status !== 'known'
        ? el('button', { class: 'btn sm ghost', onclick: () => setStatus(w.word, 'known') }, 'Know it')
        : el('button', { class: 'btn sm ghost', onclick: () => setStatus(w.word, 'learning') }, 'Relearn'),
      el('button', { class: 'btn sm ghost', onclick: () => remove(w.word), title: 'Remove' }, '✕'),
    ),
  );
}

function renderList() {
  const filtered = words.filter((w) =>
    (!state.status || w.status === state.status) &&
    (!state.q || w.word.includes(state.q) || String(w.zh).includes(state.q)));

  listEl.replaceChildren();
  if (!filtered.length) {
    listEl.append(el('div', { class: 'empty' }, words.length ? 'Nothing matches that filter.' : 'No words yet — go highlight some in a talk.'));
    return;
  }
  for (const w of filtered) listEl.append(row(w));
}

function renderStatusFilters() {
  const counts = words.reduce((m, w) => ({ ...m, [w.status]: (m[w.status] || 0) + 1 }), {});
  document.getElementById('statusFilters').replaceChildren(
    ...['new', 'learning', 'known', 'retired']
      .filter((s) => counts[s])
      .map((s) => el('button', {
        class: `chip ${state.status === s ? 'on' : ''}`,
        onclick: () => { state.status = state.status === s ? '' : s; renderStatusFilters(); renderList(); },
      }, `${titleCase(s)} ${counts[s]}`))
  );
}

async function setStatus(word, status) {
  await api.post('/api/word-status', { word, status });
  const w = words.find((x) => x.word === word);
  if (w) w.status = status;
  renderStatusFilters();
  renderList();
  renderStats();
  toast(`“${word}” → ${status}`);
}

async function remove(word) {
  await api.post('/api/word-delete', { word });
  words = words.filter((w) => w.word !== word);
  renderStatusFilters();
  renderList();
  renderStats();
  toast(`Removed “${word}”`);
}

// ---------------------------------------------------------------- flashcards

function startFlashcards() {
  const deck = words.filter((w) => w.status !== 'retired');
  if (!deck.length) return toast('No words to review yet');
  deck.sort(() => Math.random() - 0.5);

  let i = 0;
  let flipped = false;
  const started = Date.now();
  const results = [];

  const draw = () => {
    const w = deck[i];
    studyEl.replaceChildren(el('div', { class: 'flash' },
      el('div', { class: 'sub', style: 'margin:0' }, `${i + 1} / ${deck.length}`),
      el('div', { class: 'big' }, w.word),
      el('div', { class: 'ipa', style: 'font-family:var(--mono);color:var(--ink-3)' }, w.ipa_us || w.ipa_uk || ''),
      flipped
        ? el('div', {},
            el('div', { class: 'zh', style: 'font-size:1.15rem' }, w.zh),
            w.context ? el('div', { class: 'ctx' }, `“${w.context}”`) : null)
        : el('button', { class: 'btn ghost', onclick: () => { flipped = true; draw(); } }, 'Show meaning'),
      el('div', { style: 'display:flex; gap:.5rem; margin-top:.5rem' },
        el('button', { class: 'btn sm ghost', onclick: () => playAudio(w.audio_us || w.audio_uk, w.word, 'us') }, '🔊 Hear it'),
        flipped ? el('button', { class: 'btn sm ghost', onclick: () => next(false) }, 'Still learning') : null,
        flipped ? el('button', { class: 'btn sm', onclick: () => next(true) }, 'Got it') : null,
        el('button', { class: 'btn sm ghost', onclick: finish }, 'End'),
      ),
    ));
  };

  const next = (correct) => {
    results.push({ word: deck[i].word, correct });
    i++;
    flipped = false;
    if (i >= deck.length) return finish();
    draw();
  };

  const finish = async () => {
    studyEl.style.display = 'none';
    if (results.length) {
      await api.post('/api/review', { type: 'flashcard', results, seconds: (Date.now() - started) / 1000 });
      toast(`Logged ${results.length} cards`);
      await reload();
    }
  };

  studyEl.style.display = '';
  draw();
}

// ---------------------------------------------------------------------- test

function startTest() {
  const pool = words.filter((w) => w.status !== 'retired' && w.zh);
  if (pool.length < 4) return toast('Save at least 4 words first');

  const deck = [...pool].sort(() => Math.random() - 0.5).slice(0, 10);
  let i = 0;
  const results = [];
  const started = Date.now();

  const draw = () => {
    const w = deck[i];
    // Alternate the two formats — recognition, then production.
    const useCloze = Boolean(w.context) && i % 2 === 1;
    const distractors = pool.filter((x) => x.word !== w.word).sort(() => Math.random() - 0.5).slice(0, 3);
    const options = [w, ...distractors].sort(() => Math.random() - 0.5);

    const prompt = useCloze
      ? el('div', { class: 'ctx' },
          ...w.context.split(new RegExp(`\\b${w.word}\\w*\\b`, 'i')).flatMap((part, idx, arr) =>
            idx < arr.length - 1 ? [part, el('span', { class: 'blank' }, '?')] : [part]))
      : el('div', { class: 'big' }, w.word);

    studyEl.replaceChildren(el('div', { class: 'flash' },
      el('div', { class: 'sub', style: 'margin:0' }, `Question ${i + 1} of ${deck.length}`),
      prompt,
      el('div', { class: 'sub', style: 'margin:0' }, useCloze ? 'Which word fills the gap?' : 'What does it mean?'),
      el('div', { class: 'opts' },
        ...options.map((o) => el('button', {
          class: 'opt',
          onclick: (e) => answer(e.currentTarget, o.word === w.word, w),
        }, useCloze ? o.word : o.zh))),
      el('button', { class: 'btn sm ghost', onclick: finish }, 'End test'),
    ));
  };

  const answer = (btn, correct, w) => {
    studyEl.querySelectorAll('.opt').forEach((b) => { b.disabled = true; });
    btn.classList.add(correct ? 'right' : 'wrong');
    results.push({ word: w.word, correct });
    setTimeout(() => { i++; i >= deck.length ? finish() : draw(); }, correct ? 500 : 1400);
  };

  const finish = async () => {
    studyEl.style.display = 'none';
    if (!results.length) return;
    const r = await api.post('/api/review', { type: 'test', results, seconds: (Date.now() - started) / 1000 });
    toast(`${r.correct} / ${r.seen} correct — logged to your vault`);
    await reload();
  };

  studyEl.style.display = '';
  draw();
}

// --------------------------------------------------------------------- boot

async function reload() {
  words = (await api.get('/api/words')).rows;
  renderStatusFilters();
  renderList();
  await renderStats();
}

document.getElementById('q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderList(); });
document.getElementById('flashBtn').addEventListener('click', startFlashcards);
document.getElementById('testBtn').addEventListener('click', startTest);

await reload();
