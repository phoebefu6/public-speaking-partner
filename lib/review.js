// Review log and progress stats.
//
// One note per study day in 05-review/, so the log reads as a diary in Obsidian rather
// than an opaque ledger. Streaks and the heatmap are derived from these files, which
// means the vault alone is enough to reconstruct every number the app shows.

import { DIRS, listNotes, readNote, vaultPath, writeNote } from './vault.js';
import { allWords } from './library.js';

const iso = (d) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());

const dayPath = (date) => vaultPath(DIRS.review, `${date}.md`);

/** Append one finished session to today's review note. */
export function logSession({ type = 'test', seen = 0, correct = 0, seconds = 0, talk = '' } = {}) {
  const date = today();
  const abs = dayPath(date);
  const existing = readNote(abs);

  const fm = existing?.frontmatter || {
    date, type: 'review-log', sessions: 0, words_seen: 0, correct: 0, seconds: 0,
  };
  fm.sessions = (Number(fm.sessions) || 0) + 1;
  fm.words_seen = (Number(fm.words_seen) || 0) + seen;
  fm.correct = (Number(fm.correct) || 0) + correct;
  fm.seconds = (Number(fm.seconds) || 0) + Math.round(seconds);

  const stamp = new Date().toTimeString().slice(0, 5);
  const line = `- \`${stamp}\` **${type}** — ${correct}/${seen} correct, ${Math.round(seconds / 60)} min${talk ? ` · ${talk}` : ''}`;
  const body = existing?.body?.includes('## Sessions')
    ? existing.body.replace(/(## Sessions\n)/, `$1${line}\n`)
    : `## Sessions\n${line}\n`;

  writeNote(abs, fm, body);
  return { date, ...fm };
}

function loadDays() {
  const days = new Map();
  for (const abs of listNotes(DIRS.review)) {
    const fm = readNote(abs)?.frontmatter;
    if (!fm?.date) continue;
    days.set(fm.date, {
      date: fm.date,
      sessions: Number(fm.sessions) || 0,
      seen: Number(fm.words_seen) || 0,
      correct: Number(fm.correct) || 0,
      seconds: Number(fm.seconds) || 0,
    });
  }
  return days;
}

/** Consecutive days ending today (or yesterday — one grace day, so a late night still counts). */
function streakFrom(days) {
  let streak = 0;
  const cursor = new Date();
  if (!days.has(iso(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(iso(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function stats() {
  const days = loadDays();
  const words = allWords();

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekCut = iso(weekAgo);

  const byStatus = { new: 0, learning: 0, known: 0, retired: 0 };
  let addedThisWeek = 0;
  for (const w of words) {
    const s = String(w.status || 'new').toLowerCase();
    if (s in byStatus) byStatus[s]++;
    if (String(w.added || '') >= weekCut) addedThisWeek++;
  }

  // 52 weeks of activity for the heatmap.
  const heatmap = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - 363);
  for (let i = 0; i < 364; i++) {
    const date = iso(cursor);
    heatmap.push({ date, count: days.get(date)?.seen || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const totals = [...days.values()].reduce(
    (acc, d) => ({ seen: acc.seen + d.seen, correct: acc.correct + d.correct, seconds: acc.seconds + d.seconds }),
    { seen: 0, correct: 0, seconds: 0 }
  );

  return {
    streak: streakFrom(days),
    studyDays: days.size,
    totalWords: words.length,
    byStatus,
    addedThisWeek,
    reviewedTotal: totals.seen,
    accuracy: totals.seen ? Math.round((totals.correct / totals.seen) * 100) : null,
    minutesTotal: Math.round(totals.seconds / 60),
    heatmap,
    todayLogged: days.has(today()),
  };
}
