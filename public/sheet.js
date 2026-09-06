import { api, el, mountChrome, toast } from './common.js';

mountChrome('sheet');

const scopeEl = document.getElementById('scope');
const valueEl = document.getElementById('value');
const sheetEl = document.getElementById('sheet');

let words = [];
let talks = [];

const params = () => new URLSearchParams({
  scope: scopeEl.value,
  value: scopeEl.value === 'all' ? '' : valueEl.value,
});

function fillValues() {
  const scope = scopeEl.value;
  valueEl.style.display = scope === 'all' ? 'none' : '';
  if (scope === 'all') return render();

  let options = [];
  if (scope === 'status') {
    options = [...new Set(words.map((w) => w.status))].map((s) => ({ v: s, label: s }));
  } else if (scope === 'talk') {
    const ids = [...new Set(words.map((w) => w.talk).filter(Boolean))];
    options = ids.map((id) => ({ v: id, label: talks.find((t) => t.id === id)?.title || id }));
  } else if (scope === 'tag') {
    const tags = new Set();
    for (const w of words) String(w.exam_tags || '').split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => tags.add(t));
    options = [...tags].map((t) => ({ v: t, label: t }));
  }

  valueEl.replaceChildren(...options.map((o) => el('option', { value: o.v }, o.label)));
  render();
}

async function render() {
  const data = await api.get(`/api/sheet?${params()}&format=json`);
  sheetEl.replaceChildren();

  if (!data.rows.length) {
    sheetEl.append(el('div', { class: 'empty' }, 'Nothing in this slice yet.'));
    return;
  }

  sheetEl.append(el('div', { class: 'sub', style: 'margin:0 0 1rem' },
    `${data.label} · ${data.count} ${data.count === 1 ? 'word' : 'words'}`));

  const groups = new Map();
  for (const r of data.rows) {
    const key = r.talk_title || 'Unsorted';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  for (const [title, items] of groups) {
    sheetEl.append(el('h2', {}, title));
    for (const r of items) {
      sheetEl.append(el('div', { class: 'item' },
        el('div', {},
          el('b', {}, r.word),
          r.ipa_us || r.ipa_uk ? el('span', { class: 'ipa' }, r.ipa_us || r.ipa_uk) : null,
          r.exam_tags ? el('span', { class: 'chip gold', style: 'margin-left:.4rem' }, r.exam_tags) : null,
        ),
        el('div', { class: 'z' }, r.zh),
        r.example || r.context ? el('div', { class: 'e' }, `“${r.example || r.context}”`) : null,
      ));
    }
  }
}

async function download(format, ext, mime) {
  const res = await fetch(`/api/sheet?${params()}&format=${format}`);
  const text = await res.text();
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el('a', { href: url, download: `cheat-sheet-${new Date().toISOString().slice(0, 10)}.${ext}` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`Downloaded ${ext.toUpperCase()}`);
}

scopeEl.addEventListener('change', fillValues);
valueEl.addEventListener('change', render);
document.getElementById('print').addEventListener('click', () => window.print());
document.getElementById('md').addEventListener('click', () => download('md', 'md', 'text/markdown'));
document.getElementById('csv').addEventListener('click', () => download('csv', 'csv', 'text/csv'));

words = (await api.get('/api/words')).rows;
talks = (await api.get('/api/talks?limit=100')).rows;
fillValues();
