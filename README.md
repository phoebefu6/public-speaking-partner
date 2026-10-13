# Speech Partner

A local tool for studying talks as **craft**, not just as vocabulary.

Paste a TED or YouTube link → read the transcript → click any word → get IPA, audio, 中文, and
**sourced** usage examples → the word becomes a note in a plain Markdown vault you can review,
test, and export. Alongside the words, the lines worth reciting and the rhetoric that makes them
work get captured too.

Everything runs on your own machine. The vault is the source of truth; the app is a reader over it.

## The idea worth stealing: two transcript layers

TED transcripts are unproofed. A learner reading one aloud learns its errors as correct English —
one talk in this vault carried 53 genuine grammar errors. But the obvious fix, running a grammar
pass over the text, destroys the thing you came for: *Until it was.* / *Sight turning to insight.*
/ *It can scale.* are the best lines in the vault, and every one of them is a sentence fragment.

So nothing is ever edited in place. Each talk holds two layers:

- **`## Transcript`** — verbatim, never touched. It is what the speaker actually said, and the cue
  timings key off it.
- **`## Transcript (reviewed)`** — the corrected layer beside it, written as a list of visible
  `was → now` edits, each tagged with why it changed.

Corrections are typed, and two of the four types mean *do not touch*:

| | Meaning |
|---|---|
| `g` | Grammar or usage — genuinely wrong, fix it |
| `t` | Transcription artifact — the text is broken, fix it |
| `q` | Judgment call — **flag it, don't silently fix it** |
| `k` | Craft — looks wrong, is deliberate — **never touch it** |

The reader shows both layers side by side, so the grammar is something you can study rather than
something that silently happened to you.

## The model never writes the text

`POST /api/talk/<id>/polish` runs that review through Claude. The model returns **only edits** —
it never retypes a paragraph — and the server applies them, asserting that every `was` occurs
**exactly once** in its paragraph and that every craft line really exists in the verbatim.
Anything failing that check is rejected individually and reported.

A model that invents a quote, or retypes a curly apostrophe as a straight one, cannot corrupt the
vault. The worst case is a pass that fails loudly.

It tries two transports in order — the Anthropic API when a key is set, then the `claude` CLI on a
Claude subscription — and falls through only on a credential failure, so a talk that genuinely
failed to review is never retried on the other door and billed twice.

## Run it

```bash
npm start
```

Then open <http://localhost:4321>. Node 22+ (`node:sqlite` and `--env-file`).

Configuration is a `.env` file, read at boot:

```
PORT=4321
VAULT_PATH=/path/to/your/vault

# Optional — mirror the vault to a Notion database you can read on your phone
NOTION_TOKEN=
NOTION_DATABASE_ID=
NOTION_DATA_SOURCE_ID=

# Optional — the Polish pass. Falls back to the `claude` CLI when unset.
ANTHROPIC_API_KEY=
```

Nothing here requires any of it: with no keys at all, ingesting, reading, word cards, and review
all work offline.

## Where things live

**The vault is the source of truth.** It is a plain Obsidian vault — Markdown with YAML
frontmatter, under git. Open it in Obsidian and everything the app knows is there in readable form.

| Folder | Holds |
|---|---|
| `01-talks/<source>/<year>/` | One note per speech: metadata, both transcript layers, corrections, cue timings |
| `02-vocab/` | One note per word — IPA, 中文, sourced examples, review state |
| `03-phrases/` | One note per line worth reciting, filed by what the sentence *does* |
| `04-craft/` | Per talk: opening move, the spine, devices, closing move, delivery to steal |
| `05-review/` `06-coaching/` | The study log, and recurring grammar patterns |
| `00-dashboard/` | Derived views — rebuild with `npm run dashboards`, never hand-edited |

`data/cache.db` is a **disposable** SQLite index. Delete it any time and run `npm run resync` —
it rebuilds from the vault in milliseconds. Nothing lives only in the cache.

`data/ecdict.db` is the offline EN→中文 dictionary (770,611 entries, 56,409 lemma pairs). Rebuild
with `npm run build-dict` if `data/ecdict.csv` is present.

## How a word card is assembled

1. **Lemma** — ECDICT's `exchange` field resolves the surface form (`ushered` → `usher`).
   Without this most highlights would miss, since transcripts contain inflections, not headwords.
2. **中文 + difficulty** — offline ECDICT: gloss, part of speech, CET4/6 · 考研 · TOEFL · IELTS · GRE
   tags, Collins rating, frequency rank.
3. **Pronunciation** — dictionaryapi.dev IPA and UK/US recordings. Where a word has no recording,
   the browser's speech synthesis reads it and the card says `IPA` rather than claiming an accent.
4. **Examples**, each labelled with its origin — the talk's own sentence first, then real
   dictionary examples, then Tatoeba corpus sentences (with contributor and licence).
   **Nothing is AI-generated.** A card showing three real examples is correct; padding it to five
   with invented ones is not.
5. **YouGlish** link to watch real speakers say the word on video.

The card also surfaces the **collocation** — `ushered in` rather than `usher` — because for a
speaker the phrase is the reusable unit, more than the headword.

## Dialogues

For a two-hander, `speaker` in the frontmatter is both names joined, which is not who said any
given line. `GET /api/talk/<id>` returns a `speakers` array resolving one name per paragraph from
the turn markers, so a phrase can be credited to the person who actually said it.

Turn markers and stage directions are excluded from the word count, the grade, and the clickable
text — `SK` resolves to 链球菌激酶 in a Chinese-English dictionary, and nothing else would stop you
saving it. `public/labels.js` decides what counts as non-lexical and is imported by the server
*and* the browser, so the reader, the word count and the grader cannot drift apart.

## Sources

TED (page data), YouTube (captions via `yt-dlp`), and pasted text. Podcast audio transcription is
not built — paste the transcript instead.

YouTube auto-captions scroll: each cue repeats the tail of the previous one, which once turned a
3,533-word talk into 10,584 words of mostly duplicates. The parser compares cue *lines* rather than
whole cues to drop the overlap. If a transcript's word count looks wrong against its runtime, that
is the first thing to check.

`yt-dlp` needs to stay current or YouTube starts refusing it:

```bash
pip3 install --user -U yt-dlp
```

## Dependencies

One: `@anthropic-ai/sdk`, used only by the optional Polish pass. Everything else is Node's own
standard library — `node:http`, `node:sqlite`, `fetch`, and `--env-file`. No framework, no
bundler, no build step.

## Status

A personal tool, published because the two-layer transcript idea and the edits-not-rewrites
constraint on the model may be useful to someone else. It is shaped around one person's study
habits and is not packaged as a product.
