#!/usr/bin/env node
/**
 * What a Grafana dashboard in this repository must be true of, checked without
 * a cluster.
 *
 *   node scripts/check-dashboards.mjs
 *
 * These boards are deployed by copying their JSON into a ConfigMap, which
 * Grafana's file provider reads. Nothing validates them on the way in: a board
 * with a typo in a datasource uid, or one that pushes the ConfigMap past
 * etcd's object limit, fails in the cluster rather than in review — and the
 * symptom is an empty panel, which reads like "no data" rather than "broken".
 *
 * So the rules below are the ones whose violation is invisible until somebody
 * is looking at a blank graph during an incident.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const DIR = 'deploy/observability/grafana/dashboards';

/**
 * The datasource uid every panel must point at.
 *
 * Fixed in `grafana/values.yaml` with a comment saying it must not change,
 * because every board references it by uid rather than by name. A board that
 * names anything else silently renders nothing.
 */
const DATASOURCE_UID = 'vm';

/**
 * etcd refuses an object above ~1.5 MiB and Kubernetes rejects a ConfigMap
 * above 1 MiB of data. One well-meaning export from the Grafana UI — they are
 * verbose — can cross it, and the failure lands on whoever next runs the
 * deploy rather than on whoever added the board.
 */
const CONFIGMAP_LIMIT_BYTES = 1024 * 1024;

const problems = [];
const note = (file, message) => problems.push(`${file}: ${message}`);

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error(`no dashboards found in ${DIR}`);
  process.exit(1);
}

const seenUids = new Map();
let totalBytes = 0;

for (const file of files) {
  const path = join(DIR, file);
  totalBytes += statSync(path).size;
  const raw = readFileSync(path, 'utf8');

  let board;
  try {
    board = JSON.parse(raw);
  } catch (error) {
    note(file, `does not parse as JSON — ${error.message}`);
    continue;
  }

  // The uid is the dashboard's identity across restarts and the thing a link
  // or an alert annotation points at. Tying it to the filename keeps a rename
  // from quietly becoming a second copy.
  const expected = basename(file, '.json');
  if (board.uid !== expected) {
    note(file, `uid is "${board.uid}", expected "${expected}" to match the filename`);
  }
  if (seenUids.has(board.uid)) {
    note(file, `uid "${board.uid}" is already used by ${seenUids.get(board.uid)}`);
  }
  seenUids.set(board.uid, file);

  if (!board.title) note(file, 'has no title');

  const panels = board.panels ?? [];
  if (panels.length === 0) note(file, 'has no panels');

  for (const panel of panels) {
    const where = `panel "${panel.title ?? '(untitled)'}"`;

    // A panel-level datasource is optional; a wrong one is not.
    if (panel.datasource?.uid && panel.datasource.uid !== DATASOURCE_UID) {
      note(file, `${where} points at datasource "${panel.datasource.uid}", not "${DATASOURCE_UID}"`);
    }

    for (const target of panel.targets ?? []) {
      if (target.datasource?.uid && target.datasource.uid !== DATASOURCE_UID) {
        note(file, `${where} has a target on datasource "${target.datasource.uid}"`);
      }
      if ('expr' in target && !String(target.expr).trim()) {
        note(file, `${where} has an empty query`);
      }
    }
  }

  // A template variable that queries the wrong datasource renders an empty
  // dropdown, which looks like "this environment has no data" rather than like
  // a broken board.
  for (const variable of board.templating?.list ?? []) {
    if (variable.type === 'query' && variable.datasource?.uid !== DATASOURCE_UID) {
      note(file, `variable $${variable.name} queries datasource "${variable.datasource?.uid}"`);
    }
  }
}

if (totalBytes > CONFIGMAP_LIMIT_BYTES) {
  problems.push(
    `the dashboards total ${(totalBytes / 1024).toFixed(0)} KiB, over the ` +
      `${CONFIGMAP_LIMIT_BYTES / 1024} KiB a ConfigMap accepts — split them ` +
      'across two ConfigMaps and mount both',
  );
}

for (const problem of problems) console.error(`  FAIL  ${problem}`);

if (problems.length > 0) {
  console.error(`\ndashboards: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(
  `dashboards OK: ${files.length} board(s), ${seenUids.size} distinct uid(s), ` +
    `${(totalBytes / 1024).toFixed(0)} KiB of ${CONFIGMAP_LIMIT_BYTES / 1024} KiB ConfigMap budget`,
);
