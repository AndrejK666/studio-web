/* The project's glossary (glossary-view.ts): what each word means, the pairs
 * that are probably one thing, and the words nobody has defined. Rows come a
 * page at a time and merging searches, so it opens at once however many words
 * the documents use. */
import { useMemo, useState } from "react";

import type { GlossaryRenameProposal } from "./api";
import { LAYER_TITLE } from "./domain-layers";
import { filterRows, glossaryRows, mergeCandidates, renameOffer, similarPairs, type GlossaryFilter, type GlossaryRow } from "./glossary-view";
import type { Entity, GlossaryEntry } from "./spec-model";

type Decide = (key: string, decision: { name: string | null; alias_of: string | null }) => Promise<void>;
type Rename = { from: string; to: string };
/** Offer, after a decision, to carry a rename into the documents. */
type Offer = (rename: Rename | null) => void;

const PAGE = 60;

export function GlossaryScreen({
  entries,
  entities,
  onDecide,
  onProposeRename,
}: {
  entries: GlossaryEntry[];
  entities: Entity[];
  onDecide: Decide;
  onProposeRename: (from: string, to: string) => Promise<GlossaryRenameProposal>;
}) {
  const [offer, setOffer] = useState<Rename | null>(null);
  const [proposing, setProposing] = useState(false);
  const [proposed, setProposed] = useState<GlossaryRenameProposal | null>(null);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const offerRename: Offer = (rename) => {
    setOffer(rename);
    setProposed(null);
    setProposeError(null);
  };
  const propose = (rename: Rename) => {
    setProposing(true);
    setProposeError(null);
    onProposeRename(rename.from, rename.to)
      .then((r) => setProposed(r))
      .catch((e: unknown) => setProposeError(e instanceof Error ? e.message : String(e)))
      .finally(() => setProposing(false));
  };
  const [filter, setFilter] = useState<GlossaryFilter>("all");
  const [text, setText] = useState("");
  const [shown, setShown] = useState(PAGE);
  /** Pairs a person said are different things: not suggested again here. */
  const [apart, setApart] = useState<Set<string>>(new Set());
  const rows = useMemo(() => glossaryRows(entries, entities), [entries, entities]);
  const pairs = useMemo(() => similarPairs(entries).filter((p) => !apart.has(`${p.a.key}|${p.b.key}`)), [entries, apart]);
  const list = useMemo(() => filterRows(rows, filter, text, pairs), [rows, filter, text, pairs]);
  const undefinedCount = useMemo(() => rows.filter((r) => !r.definition && r.layer !== null).length, [rows]);
  const named = useMemo(() => rows.filter((r) => r.entry.chosen || r.entry.aliases.length > 0).length, [rows]);

  if (entries.length === 0) return <div className="empty">Nothing read yet. Build the model to read the documents.</div>;

  const chip = (id: GlossaryFilter, label: string, n: number) => (
    <button
      type="button"
      className={filter === id ? "chip on" : "chip"}
      onClick={() => {
        setFilter(id);
        setShown(PAGE);
      }}
    >
      {label} <span className="chip-n">{n}</span>
    </button>
  );

  return (
    <div className="gl">
      <p className="dm-howto">
        <b>Settle the project&apos;s words.</b> Give each thing one name, merge two names of one thing, and define what
        nobody has. The model, its checks and every document&apos;s review then read the same word the same way.
      </p>
      <div className="gl-bar">
        <input type="search" placeholder="Find a word or what it means" value={text} onChange={(e) => setText(e.target.value)} aria-label="Find a word" />
        {chip("all", "All", rows.length)}
        {chip("similar", "Maybe one thing", pairs.length)}
        {chip("undefined", "Not defined", undefinedCount)}
        {chip("named", "Settled by you", named)}
      </div>

      {offer && (
        <section className="card gl-offer" aria-live="polite">
          {proposed ? (
            <span>
              Proposed renaming “{offer.from}” to “{offer.to}” in {proposed.files.length} document{proposed.files.length === 1 ? "" : "s"} ({proposed.renamed} use
              {proposed.renamed === 1 ? "" : "s"}):{" "}
              {proposed.pr_url ? (
                <a href={proposed.pr_url} target="_blank" rel="noreferrer">
                  {proposed.pr_url}
                </a>
              ) : (
                <code>{proposed.branch}</code>
              )}
            </span>
          ) : (
            <span>
              The documents still say “{offer.from}” (and its plural and possessive forms).{" "}
              <button type="button" className="primary" disabled={proposing} onClick={() => propose(offer)}>
                {proposing ? "Proposing…" : `Propose renaming “${offer.from}” to “${offer.to}” in the documents`}
              </button>
              {proposeError && <span className="hint"> {proposeError}</span>}
            </span>
          )}{" "}
          <button type="button" className="ghost" onClick={() => offerRename(null)}>
            {proposed ? "Close" : "Not now"}
          </button>
        </section>
      )}

      {filter !== "named" && pairs.length > 0 && (
        <section className="card gl-pairs">
          <div className="dm-h">Probably one thing under two names</div>
          {pairs.slice(0, filter === "similar" ? pairs.length : 5).map((p) => (
            <div key={`${p.a.key}|${p.b.key}`} className="gl-pair">
              <span>
                <b>{p.a.name}</b> and <b>{p.b.name}</b> <span className="hint">— {p.why}</span>
              </span>
              <span className="gl-pair-actions">
                <button type="button" className="primary" title={`Read “${p.b.name}” as “${p.a.name}”`} onClick={() => void onDecide(p.b.key, { name: null, alias_of: p.a.key }).then(() => offerRename(renameOffer(p.b, p.a.name)))}>
                  Same thing
                </button>
                <button type="button" className="ghost" onClick={() => setApart((s) => new Set(s).add(`${p.a.key}|${p.b.key}`))}>
                  Different things
                </button>
              </span>
            </div>
          ))}
          {filter !== "similar" && pairs.length > 5 && (
            <button type="button" className="dm-link" onClick={() => setFilter("similar")}>
              all {pairs.length} pairs
            </button>
          )}
        </section>
      )}

      <ul className="gl-list">
        {list.slice(0, shown).map((r) => (
          <GlossaryItem key={r.entry.key} row={r} entries={entries} onDecide={onDecide} onOffer={offerRename} />
        ))}
      </ul>
      {list.length === 0 && <div className="empty">Nothing matches.</div>}
      {list.length > shown && (
        <button type="button" className="ghost" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, list.length - shown)} more of {list.length - shown}
        </button>
      )}
    </div>
  );
}

function GlossaryItem({ row, entries, onDecide, onOffer }: { row: GlossaryRow; entries: GlossaryEntry[]; onDecide: Decide; onOffer: Offer }) {
  const e = row.entry;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const others = e.spellings.filter((s) => s !== e.name);
  const candidates = merging === null ? [] : mergeCandidates(e, entries, merging);
  return (
    <li className="gl-item">
      <div className="gl-head">
        {renaming !== null ? (
          <form
            className="gl-inline"
            onSubmit={(ev) => {
              ev.preventDefault();
              const name = renaming.trim();
              void onDecide(e.key, { name: name || null, alias_of: null }).then(() => {
                setRenaming(null);
                onOffer(renameOffer(e, name));
              });
            }}
          >
            <input autoFocus aria-label={`Name for ${e.name}`} value={renaming} onChange={(ev) => setRenaming(ev.target.value)} />
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" className="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <b className="gl-term">{e.name}</b>
            {row.layer && <span className={`dm-layer-pill dm-layer-${row.layer}`}>{LAYER_TITLE[row.layer]}</span>}
            {e.chosen && <span className="dm-pill dm-ok">named by you</span>}
            <span className="hint">
              {e.facts} fact{e.facts === 1 ? "" : "s"} · {e.documents} doc{e.documents === 1 ? "" : "s"}
            </span>
          </>
        )}
        {renaming === null && (
          <span className="gl-actions">
            <button type="button" className="dm-link" onClick={() => setRenaming(e.name)}>
              Rename
            </button>
            {e.chosen && (
              <button type="button" className="dm-link" onClick={() => void onDecide(e.key, { name: null, alias_of: null })}>
                Use the documents&apos; name
              </button>
            )}
            <button type="button" className="dm-link" aria-expanded={merging !== null} onClick={() => setMerging(merging === null ? "" : null)}>
              Same thing as…
            </button>
          </span>
        )}
      </div>
      <div className={row.definition ? "gl-def" : "gl-def gl-missing"}>
        {row.definition ?? (row.layer ? "No document says what this is yet." : "A word the documents use; not one of the product's things.")}
      </div>
      {(others.length > 0 || e.aliases.length > 0) && (
        <div className="gl-names">
          {others.length > 0 && <span className="hint">Also written {others.join(", ")}.</span>}
          {e.aliases.map((a) => (
            <button key={a.key} type="button" className="chip" title={`Split “${a.name}” out into a word of its own`} onClick={() => void onDecide(a.key, { name: null, alias_of: null })}>
              = {a.name} ×
            </button>
          ))}
        </div>
      )}
      {merging !== null && (
        <div className="gl-merge">
          <input autoFocus type="search" placeholder={`Which word is “${e.name}” another name for?`} value={merging} onChange={(ev) => setMerging(ev.target.value)} aria-label={`Merge ${e.name} into`} />
          {candidates.map((c) => (
            <button key={c.key} type="button" className="chip" onClick={() => void onDecide(e.key, { name: e.chosen ? e.name : null, alias_of: c.key }).then(() => {
                    setMerging(null);
                    onOffer(renameOffer(e, c.name));
                  })
              }>
              {c.name} <span className="chip-n">{c.facts}</span>
            </button>
          ))}
          {merging.trim() && candidates.length === 0 && <span className="hint">No word matches.</span>}
        </div>
      )}
    </li>
  );
}
