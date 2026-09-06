import { api, el, fmtDuration, mountChrome, titleCase, toast } from './common.js';

mountChrome('catalog');

const state = { q: '', source: '', difficulty: '', status: '', topic: '', offset: 0, limit: 30 };
const cards = document.getElementById('cards');
const countEl = document.getElementById('count');
const moreBtn = document.getElementById('more');

// ------------------------------------------------------------------ rendering

function ring(pct) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.innerHTML = `
    <circle cx="20" cy="20" r="${r}" fill="none" stroke="var(--line)" stroke-width="3"/>
    <circle cx="20" cy="20" r="${r}" fill="none" stroke="var(--gold)" stroke-width="3"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}"
      transform="rotate(-90 20 20)" stroke-linecap="round"/>
    <text x="20" y="24" text-anchor="middle">${Math.round(pct)}%</text>`;
  return svg;
}

function card(t) {
  // The ring only earns its place once something has actually been mastered — a row of
  // identical 0% circles is noise, not progress.
  const pct = t.new_words && t.mastered ? (t.mastered / t.new_words) * 100 : 0;
  return el('a', { class: 'talkcard', href: `/read/${t.id}` },
    t.poster
      ? el('img', { class: 'thumb', src: t.poster, alt: '', loading: 'lazy' })
      : el('div', { class: 'thumb' }),
    el('div', {},
      el('div', { class: 't' }, t.title),
      el('div', { class: 'm' },
        t.speaker ? el('span', {}, t.speaker) : null,
        el('span', {}, titleCase(t.source)),
        t.duration ? el('span', {}, fmtDuration(t.duration)) : null,
        el('span', {}, `${t.words.toLocaleString()} words`),
        t.difficulty ? el('span', { class: 'chip' }, t.difficulty) : null,
        t.new_words ? el('span', { class: 'chip gold' }, `${t.new_words} saved`) : null,
      ),
    ),
    pct ? ring(pct) : null,
  );
}

async function loadFacets() {
  const f = await api.get('/api/facets');
  const box = document.getElementById('facets');
  box.replaceChildren();

  const group = (label, key, rows) => {
    if (!rows.length) return;
    box.append(el('h3', {}, label));
    for (const r of rows) {
      box.append(el('div', {
        class: `row ${state[key] === r.value ? 'on' : ''}`,
        onclick: () => { state[key] = state[key] === r.value ? '' : r.value; state.offset = 0; load(true); loadFacets(); },
      }, el('span', {}, titleCase(r.value)), el('small', {}, r.n)));
    }
  };
  group('Source', 'source', f.source);
  group('Level', 'difficulty', f.difficulty);
  group('Status', 'status', f.status);
  group('Topic', 'topic', f.topics);
}

async function load(reset) {
  if (reset) { cards.replaceChildren(); state.offset = 0; }
  const params = new URLSearchParams({
    q: state.q, offset: state.offset, limit: state.limit,
    ...(state.source && { source: state.source }),
    ...(state.difficulty && { difficulty: state.difficulty }),
    ...(state.status && { status: state.status }),
    ...(state.topic && { topic: state.topic }),
  });
  const { rows, total } = await api.get(`/api/talks?${params}`);

  countEl.textContent = total === 0
    ? ''
    : `${total.toLocaleString()} ${total === 1 ? 'talk' : 'talks'}${state.q ? ` matching “${state.q}”` : ''}`;

  if (!rows.length && state.offset === 0) {
    cards.append(el('div', { class: 'empty' },
      state.q ? 'Nothing matched. Try a different word.' : 'Nothing here yet — add your first talk above.'));
  }
  for (const t of rows) cards.append(card(t));

  state.offset += rows.length;
  moreBtn.style.display = state.offset < total ? '' : 'none';
}

// -------------------------------------------------------------------- events

let searchTimer;
document.getElementById('q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); load(true); }, 220);
});

moreBtn.addEventListener('click', () => load(false));

document.getElementById('ingest').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('url');
  const btn = document.getElementById('add');
  const url = input.value.trim();
  if (!url) return;

  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    const r = await api.post('/api/ingest', { url });
    if (r.duplicate) toast('Already in your library — opening it');
    location.href = `/read/${r.id}`;
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
});

const pasteForm = document.getElementById('pasteForm');
document.getElementById('pasteToggle').addEventListener('click', () => {
  pasteForm.style.display = pasteForm.style.display === 'none' ? 'flex' : 'none';
});
document.getElementById('pCancel').addEventListener('click', () => { pasteForm.style.display = 'none'; });

pasteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = document.getElementById('pText').value.trim();
  if (!text) return toast('Paste a transcript first');
  try {
    const r = await api.post('/api/ingest', {
      text,
      title: document.getElementById('pTitle').value,
      speaker: document.getElementById('pSpeaker').value,
    });
    location.href = `/read/${r.id}`;
  } catch (err) {
    toast(err.message);
  }
});

// Notion mirror — show whether it is connected, and allow a manual push.
const notionBtn = document.getElementById('notionSync');
const notionState = document.getElementById('notionState');

async function refreshNotionState() {
  try {
    const { configured } = await api.get('/api/notion-status');
    notionState.textContent = configured ? 'Notion: syncing automatically' : 'Notion: not connected';
    notionBtn.disabled = !configured;
    notionBtn.title = configured
      ? 'Push every talk to Notion now'
      : 'Add NOTION_TOKEN and NOTION_DATABASE_ID to .env to enable';
  } catch { /* non-critical */ }
}

notionBtn.addEventListener('click', async () => {
  notionBtn.disabled = true;
  notionBtn.textContent = 'Syncing…';
  try {
    const r = await api.post('/api/notion-sync', {});
    toast(`Synced ${r.synced.length} talk${r.synced.length === 1 ? '' : 's'} to Notion`);
  } catch (err) {
    toast(err.message);
  } finally {
    notionBtn.textContent = 'Sync to Notion';
    notionBtn.disabled = false;
  }
});

await refreshNotionState();
await loadFacets();
await load(true);
