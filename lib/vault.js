// Vault I/O — the speech vault is the source of truth. Everything here is plain
// Markdown with YAML frontmatter so Obsidian, git, and this app all read the same bytes.
//
// The frontmatter dialect is deliberately narrow: scalars, inline arrays, and quoted
// strings. We are the only writer, so we never need a full YAML parser — and not having
// one keeps this file dependency-free.

import fs from 'node:fs';
import path from 'node:path';

export const VAULT = process.env.VAULT_PATH || path.join(process.env.HOME, 'speech-vault');

export const DIRS = {
  dashboard: '00-dashboard',
  talks: '01-talks',
  vocab: '02-vocab',
  phrases: '03-phrases',
  craft: '04-craft',
  review: '05-review',
  coaching: '06-coaching',
};

export const vaultPath = (...parts) => path.join(VAULT, ...parts);

// ---------------------------------------------------------------- frontmatter

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => parseScalar(s));
  }
  if (/^"(.*)"$/s.test(v)) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  if (/^'(.*)'$/s.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v;
}

function formatScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => formatScalar(x)).join(', ')}]`;
  const s = String(v);
  // Quote anything that could confuse a YAML reader, or that Obsidian would mangle.
  if (s === '' || /[:#\[\]{}",\n]/.test(s) || /^[\s]|[\s]$/.test(s) || /^[-?&*!|>%@`]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return s;
}

export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: text };

  const head = text.slice(text.indexOf('\n') + 1, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const frontmatter = {};

  for (const line of head.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    frontmatter[line.slice(0, idx).trim()] = parseScalar(line.slice(idx + 1));
  }
  return { frontmatter, body };
}

export function serializeNote(frontmatter, body) {
  const lines = Object.entries(frontmatter)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${formatScalar(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

// ----------------------------------------------------------------- note CRUD

export function readNote(abs) {
  if (!fs.existsSync(abs)) return null;
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
  return { frontmatter, body, path: abs, rel: path.relative(VAULT, abs) };
}

export function writeNote(abs, frontmatter, body) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, serializeNote(frontmatter, body), 'utf8');
  return abs;
}

/** Merge new frontmatter keys into an existing note, leaving the body untouched. */
export function patchFrontmatter(abs, patch) {
  const note = readNote(abs);
  if (!note) return null;
  return writeNote(abs, { ...note.frontmatter, ...patch }, note.body);
}

export function listNotes(dir) {
  const root = path.isAbsolute(dir) ? dir : vaultPath(dir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.md')) out.push(abs);
    }
  };
  walk(root);
  return out;
}

/** Filesystem-safe note name that still reads like the thing it names. */
export function slugify(text, maxLen = 80) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\/\\:*?"<>|#^\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .trim();
}

export function ensureVault() {
  for (const dir of Object.values(DIRS)) fs.mkdirSync(vaultPath(dir), { recursive: true });
  return VAULT;
}

/** Next sequential talk id, e.g. TALK-0007. Scans existing notes so it survives a wipe. */
export function nextTalkId() {
  let max = 0;
  for (const abs of listNotes(DIRS.talks)) {
    const m = /^TALK-(\d+)$/.exec(readNote(abs)?.frontmatter?.id ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `TALK-${String(max + 1).padStart(4, '0')}`;
}
