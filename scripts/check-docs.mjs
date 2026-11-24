#!/usr/bin/env node
/**
 * What the documents under docs/ must be true of, checked without Studio.
 *
 *   node scripts/check-docs.mjs
 *
 * Studio reads this repository's specifications the way it reads any other:
 * by the directory and the `type` in the front matter, and by the `cpt-` ids
 * that tie a requirement to the design, the decomposition and the feature that
 * cite it. Nothing checks either on the way in. A spec without its type is
 * classified by guessing, a template published unfilled reads as a real
 * design, and an id cited after its definition was renamed points at nothing —
 * and each of these shows up as a finding in somebody else's Specs list, long
 * after the PR that caused it.
 *
 * Links are checked for the same reason: a document that was moved or renamed
 * leaves its readers on a 404 that no review notices. So are `ADR-NNNN`
 * citations: Studio's Open questions list one to a record that does not exist
 * as a problem that stops a build. Both checks also cover the Markdown Studio
 * reads outside docs/ (the root's, deploy/'s, keycloak/'s), where a dead link
 * turns up in the same list.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const DOCS = 'docs';

/** The spec directories and the `type` a document in each must declare. */
const SPEC_DIRS = {
  prd: 'prd',
  design: 'design',
  decomposition: 'decomposition',
  feature: 'feature',
  adr: 'adr',
};

/**
 * Where an id is defined. `**ID**:` defines an actor, requirement, component,
 * entry or decision; `**Contract**:` (singular) defines an external contract
 * in the design's External Dependencies. Everything else that names an id
 * cites it.
 */
const DEFINITION = /\*\*(?:ID|Contract)\*\*:\s*`(cpt-[a-z0-9-]+)`/g;
const CITATION = /`(cpt-[a-z0-9-]+)`/g;

/** A placeholder left over from a template, e.g. `# Technical Design — {Gear Name}`. */
const PLACEHOLDER_TITLE = /^#\s.*\{[A-Z][^}]*\}/m;

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** `ADR-0042`, `ADR 42`: a citation of a record in docs/adr/. */
const ADR_CITATION = /\bADR[- ]0*(\d{1,4})\b/g;

/**
 * Records cited on purpose though they are not in docs/adr/, each with where
 * the reason is written down.
 */
const ADRS_NOT_ON_MAIN = new Map([[17, 'docs/adr/README.md: "ADR-0017 is not on `main`"']]);

/** Markdown outside docs/ that Studio reads as documentation: links and ADR citations only. */
const OTHER_DOCS = ['.', 'deploy', 'keycloak'];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.md') ? [path] : [];
  });
}

function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  return Object.fromEntries(
    m[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([a-z_]+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.trim()]),
  );
}

/** Text outside fenced code blocks, where ids and links are examples, not claims. */
function prose(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '');
}

const errors = [];
const fail = (file, message) => errors.push(`${file.split(sep).join('/')}: ${message}`);

const files = walk(DOCS);
const adrNumbers = new Set(
  readdirSync(join(DOCS, 'adr'))
    .map((name) => name.match(/^(\d{4})-.*\.md$/)?.[1])
    .filter(Boolean)
    .map(Number),
);

/** Every relative link of `file` leads to a file or directory. */
function checkLinks(file, body) {
  for (const [, target] of body.matchAll(LINK)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const path = decodeURIComponent(target.split('#')[0]);
    if (!existsSync(resolve(dirname(file), path))) fail(file, `links to ${target}, which does not exist`);
  }
}

/** Every `ADR-NNNN` that `file` cites is a record in docs/adr/. */
function checkAdrCitations(file, body) {
  const cited = new Set([...body.matchAll(ADR_CITATION)].map(([, n]) => Number(n)));
  for (const n of cited) {
    if (!adrNumbers.has(n) && !ADRS_NOT_ON_MAIN.has(n)) {
      fail(file, `cites ADR-${String(n).padStart(4, '0')}, which docs/adr/ does not have`);
    }
  }
}
const definedIn = new Map();
const citations = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const body = prose(text);
  const [top, sub] = relative(DOCS, file).split(sep);
  const specType = sub !== undefined && sub !== 'README.md' ? SPEC_DIRS[top] : undefined;

  if (specType) {
    const fm = frontMatter(text);
    if (!fm?.type) fail(file, `a ${specType} spec must start with front matter declaring \`type: ${specType}\``);
    else if (fm.type !== specType) fail(file, `declares \`type: ${fm.type}\` but lives under docs/${top}/`);
    if (PLACEHOLDER_TITLE.test(text)) fail(file, 'is an unfilled template (its title still has a {placeholder})');
  }

  for (const [, id] of body.matchAll(DEFINITION)) {
    const first = definedIn.get(id);
    if (first) fail(file, `defines ${id}, already defined in ${first}`);
    else definedIn.set(id, file.split(sep).join('/'));
  }
  for (const [, id] of body.matchAll(CITATION)) citations.push([file, id]);

  checkLinks(file, body);
  // docs/upstream/ keeps other projects' documents, which cite their own ADRs.
  if (top !== 'upstream') checkAdrCitations(file, body);
}

const others = OTHER_DOCS.flatMap((dir) =>
  dir === '.' ? readdirSync('.').filter((name) => name.endsWith('.md') && statSync(name).isFile()) : walk(dir),
);
for (const file of others) {
  const body = prose(readFileSync(file, 'utf8'));
  checkLinks(file, body);
  checkAdrCitations(file, body);
}

// A document nobody can find from an index is one nobody keeps up to date.
const INDEXES = ['README.md', 'adr/README.md', 'upstream/README.md', 'inbox/README.md'].map((index) =>
  join(DOCS, index),
);
const indexed = new Set(
  INDEXES.flatMap((index) =>
    [...prose(readFileSync(index, 'utf8')).matchAll(LINK)].map(([, target]) =>
      resolve(dirname(index), decodeURIComponent(target.split('#')[0])),
    ),
  ),
);
for (const file of files) {
  if (!file.endsWith('README.md') && !indexed.has(resolve(file))) {
    fail(file, `is not linked from any index (${INDEXES.map((i) => i.split(sep).join('/')).join(', ')})`);
  }
}

// Only the ids of a system this repository defines are held to it: a
// `cpt-cf-evbk-…` id names another project's spec, which lives there.
const systemOf = (id) => id.split('-')[1];
const ownSystems = new Set([...definedIn.keys()].map(systemOf));
const dangling = new Map();
for (const [file, id] of citations) {
  if (ownSystems.has(systemOf(id)) && !definedIn.has(id)) dangling.set(`${file}\0${id}`, [file, id]);
}
for (const [file, id] of dangling.values()) fail(file, `cites ${id}, which no document defines`);

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\n${errors.length} problem(s) in the documentation.`);
  process.exit(1);
}
console.log(
  `${files.length} documents (and ${others.length} outside docs/), ${definedIn.size} ids: all specs typed, every id defined once and cited ids exist, every cited ADR exists, every link resolves.`,
);
