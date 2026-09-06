# Speech Partner

A local English learning partner built around one idea: the words worth keeping are the ones you
met in a talk you cared about, and they should keep the sentence they arrived in.

Paste a link → read the transcript → click any word → get IPA, audio, 中文, and five **sourced**
usage examples → the word becomes a note in `~/speech-vault` that you can review, test, and export.

## Run it

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
cd ~/english-partner && npm start
```

Then open <http://localhost:4321>.

## Where things live

**`~/speech-vault` is the source of truth.** It is a plain Obsidian vault — Markdown with YAML
frontmatter, under git. Open it in Obsidian and everything the app knows is there in readable form.

| Folder | Holds |
|---|---|
| `01-talks/<source>/<year>/` | One note per speech: metadata, transcript, craft notes, cue timings |
| `02-vocab/` | One note per word — IPA, 中文, sourced examples, review state |
| `03-phrases` `04-craft` `05-review` `06-coaching` | Phrasings, rhetoric, the study log, teaching material |

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
4. **Five examples**, each labelled with its origin — the talk's own sentence first, then real
   dictionary examples, then Tatoeba corpus sentences. **Nothing is AI-generated.** A card with
   three real examples is shown instead of five where two were invented.
5. **YouGlish** link to watch real speakers say the word on video.

## Sources

TED (page data), YouTube (captions via `yt-dlp`), and pasted text. Podcast audio transcription is
not built — paste the transcript instead.

`yt-dlp` needs to stay current or YouTube starts refusing it:

```bash
pip3 install --user -U yt-dlp
```

## Dependencies

None at runtime. Node 24 provides `node:http`, `node:sqlite`, `fetch`, and `--env-file`.
