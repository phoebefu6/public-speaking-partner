// The Polish pass — Claude proposes corrections, this file decides whether to believe them.
//
// The review pass is judgment, not a transform: knowing that "there's two examples" is an error
// while "Social health." is the best line in the talk. That is why it takes a model. But a model
// left to rewrite paragraphs will quietly retype them, and a fragment it "fixes" is exactly the
// thing she is here to steal.
//
// So the model never sees the reviewed text and never writes it. It returns only a list of
// `was → now` edits, and this file applies them to the verbatim and refuses the whole batch if
// any edit fails to match. Worst case the pass fails loudly; it cannot corrupt the vault.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import * as lib from './library.js';
import { knownLabels, speakerLabel } from '../public/labels.js';

const MODEL = process.env.POLISH_MODEL || 'claude-opus-5';

const NO_CREDENTIALS = 'No API key found — put one in ANTHROPIC_API_KEY in .env, then restart the server '
  + '(.env is only read at boot). Note a Claude subscription is separate from API access.';

export const SYSTEM = `You are proofreading a talk transcript for a non-native English speaker who is
training to become a public speaker and lecturer. She reads the corrected layer ALOUD, so nothing
in it may be a sentence she should not say.

She did NOT give this talk. It was given by the speaker named in the request, and the errors belong
to that speaker or to the transcriber — never to her. Refer to the speaker in the third person, by
name ("Wu drops the article…", "the transcriber split…"). Never write "your talk", "you add", or
"a pattern for you" about the transcript. "You" means her only when telling her what to steal or
watch for in her own speaking.

You return corrections only. You never rewrite or retype paragraphs.

Each correction is {p, type, was, now, why}:
  p    — zero-based paragraph index
  was  — text copied EXACTLY from that paragraph, character for character, long enough to be unique
  now  — the replacement
  why  — one or two sentences, addressed to her, explaining what the speaker or transcriber got wrong

TYPES:
  g — grammar or usage that is genuinely wrong. Fix it.
  t — transcription artifact: the transcriber's text is broken (missing sentence break, homophone,
      editorial [brackets], punctuation errors). Fix it.
  q — judgment call, defensible either way. Set "now" IDENTICAL to "was" — flag, never silently fix.
      Use this whenever repairing the text would require guessing words that are not recoverable.
  k — CRAFT: looks wrong, is deliberate, and must never be touched. Set "was" to "" and "now" to
      the line quoted exactly from the paragraph. "why" explains what the device is doing and why
      it works, in a way that teaches her to reuse the shape.

THE MOST IMPORTANT RULE — never "correct" any of these:
  - sentence fragments ("Social health." / "Until it was." / "Here's the thing.")
  - comma splices and run-ons used for pace
  - deliberate repetition ("double, double, double")
  - anaphora and parallelism across sentences
  - short answers used as a brake ("Sort of.")
These are the best lines in any talk and a grammar pass flattens all three. If a line looks wrong
but lands, it is type k, not type g. When in doubt between g and k, choose k.

Other rules:
  - NEVER invent words the transcript does not support. If a clause is garbled beyond recovery,
    mark it q and say so in "why" rather than guessing what was said.
  - Do not correct spoken-but-fine usage ("you know", "I mean", "OK?") — that is delivery.
  - Speaker turn markers ("SK:", "Sal Khan:") and stage directions ("(Applause)") are not errors.
  - Be selective. A clean scripted talk may have three or four real errors. Do not pad.
  - Aim for 4-8 craft marks on a good talk — the lines genuinely worth reciting, not every
    nice sentence.

Also return languageNotes: a short prose block (markdown, 3-4 short paragraphs) naming the
RECURRING patterns you saw, with real examples quoted from this talk. Address her directly, but credit each pattern to the
speaker, not to her. If the
talk is scripted its errors differ from an unscripted conversation — say which this is and what
that predicts. Do not repeat generic grammar advice.`;

const TOOL = {
  name: 'submit_review',
  description: 'Submit the corrections and language notes for this transcript.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      corrections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            p: { type: 'integer' },
            type: { type: 'string', enum: ['g', 't', 'q', 'k'] },
            was: { type: 'string' },
            now: { type: 'string' },
            why: { type: 'string' },
          },
          required: ['p', 'type', 'was', 'now', 'why'],
          additionalProperties: false,
        },
      },
      languageNotes: { type: 'string' },
    },
    required: ['corrections', 'languageNotes'],
    additionalProperties: false,
  },
};

const JSON_SHAPE = `Return ONLY a JSON object, no prose and no code fences:
{"corrections": [{"p": 0, "type": "g", "was": "...", "now": "...", "why": "..."}], "languageNotes": "..."}`;

/** Pull the JSON object out of a reply that may be wrapped in prose or fences. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Claude did not return JSON');
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Transport 1 — the Anthropic API. Strict tool use, so the shape is guaranteed.
 */
async function viaApi(system, user, { tool }) {
  let client;
  try {
    client = new Anthropic();
  } catch {
    throw new Error(NO_CREDENTIALS);
  }
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: user }],
  });

  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    if (/resolve authentication method/i.test(err.message)) throw new Error(NO_CREDENTIALS);
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('Claude rejected the key — check ANTHROPIC_API_KEY in .env, then restart the server');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error('Rate limited by the API — wait a moment and try again');
    }
    if (err instanceof Anthropic.APIError && err.status === 400 && /credit|billing/i.test(err.message)) {
      throw new Error('The API account has no credit — a Claude subscription does not include API usage');
    }
    if (err instanceof Anthropic.APIError) throw new Error(`Claude API error ${err.status}: ${err.message}`);
    throw err;
  }
  const block = message.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (!block) throw new Error(`Claude returned nothing usable (stop_reason: ${message.stop_reason})`);
  return { data: block.input, usage: message.usage, via: `api:${MODEL}` };
}

/**
 * Transport 2 — the Claude Code CLI, billed to her Claude subscription rather than an API key.
 *
 * She already pays for Claude Code, so `claude -p` is the cheaper door: one `/login` in a terminal
 * and the button works with no key anywhere. There is no tool-use schema over this transport, so
 * the reply is plain JSON — which is safe only because applyCorrections() rejects anything that
 * does not match the transcript regardless of how it arrived.
 */
async function viaCli(system, user, { shape }) {
  // The transcript goes over stdin, not argv: it is tens of kilobytes, and `--allowed-tools` is
  // variadic — a prompt sitting after it gets swallowed as another tool name.
  const args = [
    '--print',
    '--output-format', 'json',
    '--model', MODEL,
    '--system-prompt', shape ? `${system}\n\n${shape}` : system,
  ];

  const stdout = await new Promise((resolve, reject) => {
    // Strip the API key from the child's environment. Claude Code prefers ANTHROPIC_API_KEY over
    // its own login, so an inherited key sends this transport straight back to the API account it
    // exists to avoid — and it fails there with the same empty balance.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(e.code === 'ENOENT'
      ? new Error('The claude CLI is not installed — see claude.com/claude-code')
      : e));
    // A failed run still writes its JSON envelope to stdout — that envelope carries the real
    // reason ("Not logged in"), which is far more useful than the exit code.
    child.on('close', (code) => (out.trim()
      ? resolve(out)
      : reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 300) || 'no output'}`))));
    child.stdin.end(user);
  });

  const envelope = JSON.parse(stdout);
  if (envelope.is_error) {
    if (/not logged in/i.test(envelope.result || '')) {
      throw new Error('The claude CLI is not logged in — run `claude` in a terminal, then /login. '
        + 'No API key needed; it uses your Claude subscription.');
    }
    throw new Error(`claude CLI: ${String(envelope.result).slice(0, 300)}`);
  }
  return {
    data: extractJson(String(envelope.result || '')),
    usage: envelope.usage,
    via: `cli:${MODEL}`,
    cost: envelope.total_cost_usd,
  };
}

/** Errors that mean "this door is shut" rather than "this talk failed". */
const CREDENTIAL_FAILURE = /credit balance|no credit|authentication|not logged in|api key|invalid x-api-key/i;

/** Which door we try first. The API key goes first when present — it does not touch her Claude limits. */
export function backend() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'api';
  return 'cli';
}

/**
 * Try the preferred transport, then the other one.
 *
 * An API key with an empty credit balance and a logged-out CLI fail identically from the button's
 * point of view — the door is shut — and which door is open is not something she should have to
 * think about. Only credential-class failures fall through; a talk that genuinely could not be
 * reviewed must not be retried on the other transport and billed twice.
 */
export async function call(system, user, { tool = TOOL, shape = JSON_SHAPE } = {}) {
  const order = backend() === 'api' ? [viaApi, viaCli] : [viaCli, viaApi];
  const failures = [];
  for (const transport of order) {
    try {
      return await transport(system, user, { tool, shape });
    } catch (err) {
      if (!CREDENTIAL_FAILURE.test(err.message)) throw err;
      failures.push(err.message);
    }
  }
  throw new Error(`No usable Claude credentials.\n• ${failures.join('\n• ')}`);
}

/**
 * Apply the model's edits to the verbatim.
 *
 * Every `was` must occur exactly once in its paragraph. Anything else — zero matches because the
 * model retyped a curly apostrophe as a straight one, two matches because the quote was too short
 * to be unique — is a rejection, not something to resolve by guessing which one it meant.
 */
export function applyCorrections(verbatim, corrections) {
  const reviewed = [...verbatim];
  const rejected = [];
  const accepted = [];

  for (const c of corrections) {
    const para = verbatim[c.p];
    if (typeof para !== 'string') {
      rejected.push({ ...c, reason: `no paragraph ${c.p}` });
      continue;
    }
    if (c.type === 'k') {
      if (!c.now || !para.includes(c.now)) {
        rejected.push({ ...c, reason: 'craft line is not in the paragraph verbatim' });
        continue;
      }
      accepted.push({ ...c, was: '' });
      continue;
    }
    if (!c.was) {
      rejected.push({ ...c, reason: 'empty "was" on a non-craft correction' });
      continue;
    }
    const hits = reviewed[c.p].split(c.was).length - 1;
    if (hits !== 1) {
      rejected.push({ ...c, reason: `"was" occurs ${hits}× in paragraph ${c.p}` });
      continue;
    }
    if (c.was !== c.now) reviewed[c.p] = reviewed[c.p].replace(c.was, c.now);
    accepted.push(c);
  }
  return { reviewed, accepted, rejected };
}

/**
 * Whether credentials look present.
 *
 * An unset ANTHROPIC_API_KEY does not mean there are none — the SDK also reads
 * ANTHROPIC_AUTH_TOKEN and any profile written by `ant auth login`. Checking only the key would
 * refuse the button for someone who is perfectly well authenticated, so this is a hint for the
 * status endpoint; the call itself is the only real test.
 */
export function configured() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  return fs.existsSync(path.join(os.homedir(), '.config', 'anthropic'));
}

export async function polishTalk(id, { force = false } = {}) {
  const note = lib.findTalkById(id);
  if (!note) throw new Error(`No talk ${id}`);
  const talk = lib.parseTalkNote(note);
  const verbatim = talk.paragraphs;

  // A reviewed layer may have been written by hand, and a stray click must not spend it.
  if (Array.isArray(talk.reviewed) && talk.reviewed.length && !force) {
    throw new Error(`${id} already has a reviewed layer — polishing would overwrite it`);
  }


  const labels = knownLabels(verbatim);
  const numbered = verbatim.map((p, i) => {
    const turn = speakerLabel(p, labels);
    return `[${i}]${turn ? ` (${turn.who})` : ''} ${p}`;
  }).join('\n\n');

  const userContent = `Talk: "${note.frontmatter.title}" — ${note.frontmatter.speaker || 'unknown speaker'}`
    + ` (${note.frontmatter.source}).\n${verbatim.length} paragraphs, indexed from 0.\n\n${numbered}`;

  const { data, usage, via, cost } = await call(SYSTEM, userContent);

  const { corrections = [], languageNotes = '' } = data;
  const { reviewed, accepted, rejected } = applyCorrections(verbatim, corrections);

  // A pass that produced nothing usable should not overwrite anything.
  if (!accepted.length) {
    throw new Error(`Every correction failed to match the transcript (${rejected.length} rejected)`);
  }

  lib.writeReviewedLayer(id, { paragraphs: reviewed, corrections: accepted, languageNotes });
  return {
    id,
    via,
    cost,
    paragraphs: reviewed.length,
    accepted: accepted.length,
    rejected,
    fixes: accepted.filter((c) => c.type !== 'k').length,
    craft: accepted.filter((c) => c.type === 'k').length,
    usage: { input: usage?.input_tokens, output: usage?.output_tokens },
  };
}
