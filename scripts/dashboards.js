// Rebuild the vault's dashboard views. Safe to run any time; everything is derived
// from the notes on disk, so editing a note in Obsidian and re-running stays consistent.
import { buildDashboards } from '../lib/collections.js';
import { allTalks, findTalkById, parseTalkNote } from '../lib/library.js';

const talks = allTalks().map((t) => {
  const parsed = parseTalkNote(findTalkById(t.id));
  return { ...t, corrections: parsed.corrections.length };
});

console.log(buildDashboards(talks));
