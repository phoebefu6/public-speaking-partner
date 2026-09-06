// Shared helpers: API access, chrome, small DOM utilities.

export const api = {
  async get(path) {
    const res = await fetch(path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
};

export const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
export function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = el('div', { class: 'toast' });
    document.body.append(node);
  }
  node.textContent = message;
  requestAnimationFrame(() => node.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

export const fmtDuration = (s) => {
  if (!s) return '';
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
};

/** Top navigation with a live streak readout. */
export async function mountChrome(active) {
  const bar = el('header', { class: 'topbar' },
    el('a', { class: 'brand', href: '/' }, 'Speech', el('span', {}, '·'), 'Partner'),
    el('nav', { class: 'nav' },
      el('a', { href: '/', class: active === 'catalog' ? 'active' : '' }, 'Library'),
      el('a', { href: '/vocab', class: active === 'vocab' ? 'active' : '' }, 'Words'),
      el('a', { href: '/sheet', class: active === 'sheet' ? 'active' : '' }, 'Cheat sheet'),
    ),
    el('div', { class: 'streak', id: 'streak' }),
  );
  document.body.prepend(bar);

  try {
    const s = await api.get('/api/stats');
    document.getElementById('streak').replaceChildren(
      el('span', {}, el('span', { class: 'flame' }, '🔥 '), el('b', {}, s.streak), ' day streak'),
      el('span', {}, el('b', {}, s.byStatus.known + s.byStatus.retired), ' mastered'),
      el('span', {}, el('b', {}, s.totalWords), ' words'),
    );
  } catch { /* stats are decoration; never block the page on them */ }
}

/**
 * Acronyms and proper nouns that must not be sentence-cased into nonsense.
 * "AI" must never become "Ai"; "TED" must never become "Ted".
 */
const KEEP_UPPER = new Set(['AI', 'TED', 'UK', 'US', 'CET4', 'CET6', 'TOEFL', 'IELTS', 'GRE', 'CEFR',
  'A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'NASA', 'DNA', 'CEO', 'PDF', 'CSV', 'IPA', 'MIT', 'API']);
const KEEP_LOWER = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'vs']);

/** Title-case a label without mangling acronyms or non-Latin text. */
export function titleCase(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  return s
    .split(/(\s+|\/|·|,\s*)/)
    .map((part, i) => {
      if (/^(\s+|\/|·|,\s*)$/.test(part)) return part;
      const upper = part.toUpperCase();
      if (KEEP_UPPER.has(upper)) return upper;
      // Leave anything without Latin letters (中文, digits) exactly as it is.
      if (!/[a-z]/i.test(part)) return part;
      if (i > 0 && KEEP_LOWER.has(part.toLowerCase())) return part.toLowerCase();
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');
}

/** Last-resort browser voice, choosing the best installed English voice available. */
function speak(word, accent = 'us') {
  if (!window.speechSynthesis) return;
  const wanted = accent === 'uk' ? 'en-GB' : 'en-US';
  const voices = speechSynthesis.getVoices();
  const preferred = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Serena', 'Alex'];
  const voice =
    voices.find((v) => v.lang === wanted && preferred.includes(v.name)) ||
    voices.find((v) => v.lang === wanted && /premium|enhanced/i.test(v.name)) ||
    voices.find((v) => v.lang === wanted) ||
    voices.find((v) => v.lang?.startsWith('en'));

  const u = new SpeechSynthesisUtterance(word);
  if (voice) u.voice = voice;
  u.lang = wanted;
  u.rate = 1; // 0.85 was the "super weird" drawl — natural pace sounds like a person.
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// Some browsers populate the voice list asynchronously.
if (window.speechSynthesis) speechSynthesis.getVoices();

/**
 * Play a pronunciation, best source first:
 *   1. a real human recording from the dictionary
 *   2. a natural TTS voice, proxied through our server
 *   3. the browser's built-in synthesiser
 */
export function playAudio(url, word, accent = 'us') {
  const viaSynth = () => speak(word, accent);
  const viaTts = () => {
    const audio = new Audio(`/api/tts?word=${encodeURIComponent(word)}&accent=${accent}`);
    audio.play().catch(viaSynth);
    audio.addEventListener('error', viaSynth, { once: true });
  };

  if (url) {
    const audio = new Audio(url);
    audio.play().catch(viaTts);
    audio.addEventListener('error', viaTts, { once: true });
  } else {
    viaTts();
  }
}
