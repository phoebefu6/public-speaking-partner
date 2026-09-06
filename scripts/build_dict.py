#!/usr/bin/env python3
"""Build data/ecdict.db from data/ecdict.csv.

Two tables:
  ecdict  full entries (word, phonetic, translation, definition, pos, tag, collins, frq, bnc, exchange)
  lemma   (form -> base) for every inflected form, derived from ECDICT's `exchange` field.

The lemma table is what makes highlighting work: "emerged" in a transcript must resolve
to "emerge" before any lookup happens.
"""
import csv, os, sqlite3, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(HERE, "data", "ecdict.csv")
DB_PATH = os.path.join(HERE, "data", "ecdict.db")

csv.field_size_limit(10 * 1024 * 1024)

if not os.path.exists(CSV_PATH):
    sys.exit(f"missing {CSV_PATH}")
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)

db = sqlite3.connect(DB_PATH)
db.executescript("""
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE ecdict (
  word TEXT PRIMARY KEY, phonetic TEXT, translation TEXT, definition TEXT,
  pos TEXT, tag TEXT, collins INTEGER, oxford INTEGER, frq INTEGER, bnc INTEGER, exchange TEXT
);
CREATE TABLE lemma (form TEXT PRIMARY KEY, base TEXT);
""")


def to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


entries, lemmas, skipped = 0, 0, 0
erows, lrows = [], []

with open(CSV_PATH, newline="", encoding="utf-8") as fh:
    for row in csv.DictReader(fh):
        word = (row.get("word") or "").strip()
        if not word:
            continue
        translation = (row.get("translation") or "").strip()
        definition = (row.get("definition") or "").strip()
        exchange = (row.get("exchange") or "").strip()

        # Inflected form -> base. `0:<base>` is ECDICT's lemma pointer.
        for part in exchange.split("/"):
            if part.startswith("0:"):
                base = part[2:].strip()
                if base and base.lower() != word.lower():
                    lrows.append((word.lower(), base))
                    lemmas += 1

        if not translation and not definition:
            skipped += 1
            continue

        erows.append((
            word.lower(), (row.get("phonetic") or "").strip(), translation, definition,
            (row.get("pos") or "").strip(), (row.get("tag") or "").strip(),
            to_int(row.get("collins")), to_int(row.get("oxford")),
            to_int(row.get("frq")), to_int(row.get("bnc")), exchange,
        ))
        entries += 1

        if len(erows) >= 20000:
            db.executemany("INSERT OR REPLACE INTO ecdict VALUES (?,?,?,?,?,?,?,?,?,?,?)", erows)
            erows.clear()
        if len(lrows) >= 20000:
            db.executemany("INSERT OR REPLACE INTO lemma VALUES (?,?)", lrows)
            lrows.clear()

if erows:
    db.executemany("INSERT OR REPLACE INTO ecdict VALUES (?,?,?,?,?,?,?,?,?,?,?)", erows)
if lrows:
    db.executemany("INSERT OR REPLACE INTO lemma VALUES (?,?)", lrows)

db.executescript("CREATE INDEX idx_tag ON ecdict(tag); CREATE INDEX idx_frq ON ecdict(frq);")
db.commit()
db.execute("VACUUM")
db.close()

size_mb = os.path.getsize(DB_PATH) / 1048576
print(f"entries={entries}  lemma_pairs={lemmas}  skipped_no_translation={skipped}")
print(f"{DB_PATH}  {size_mb:.1f} MB")
