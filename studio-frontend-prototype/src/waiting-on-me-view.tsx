/* ── Waiting on you ────────────────────────────────────────────────────────────
 *
 * The Home page's answer to "what is somebody waiting on me for", across
 * every project the reader can see: the reviews somebody asked them for, and
 * the open pull requests whose next move is theirs. One list, the overdue
 * first. Each item is read from its fact, so it leaves by itself when the
 * fact changes; what the reader keeps is a mark — done, or snoozed — which
 * follows them to any browser (studio-user `me/inbox-marks`).
 *
 * Reads per workspace: `review-requests?workspace_id=&waiting_on=me` and
 * `open-pull-requests?workspace_id=&waiting_on=me`. The backend decides who
 * "me" is — the person behind the sign-in — so a reader who signed in another
 * way still gets their own list. A review event about the reader reads it
 * again (studio-events, `review_request.*`). */

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "./api";
import type { OpenPullRequest } from "./api";
import { errText } from "./format";
import {
  MY_LABEL,
  WAITING_SENTENCE,
  WAITING_TONE,
  ageLine,
  isQuiet,
  myEmptyMessage,
  myPullsInOrder,
  prRef,
} from "./pull-request-waits";
import type { ReviewRequest } from "./review-requests";
import { subscribeStudioEvents } from "./studio-events";
import { concernsMe, inboxItems, snoozeUntil, type InboxItem, type InboxMark } from "./waiting-on-me";

export interface OnMeWorkspace {
  id: string;
  name: string;
}

export function WaitingOnYou<W extends OnMeWorkspace>({
  token,
  workspaces,
  onOpenWorkspace,
}: {
  token: string;
  workspaces: W[];
  onOpenWorkspace: (ws: W) => void;
}) {
  const [pulls, setPulls] = useState<{ workspace: string; items: OpenPullRequest[] }[] | null>(null);
  const [reviews, setReviews] = useState<{ workspace: string; items: ReviewRequest[] }[]>([]);
  const [marks, setMarks] = useState<InboxMark[]>([]);
  const [membersKnown, setMembersKnown] = useState(true);
  const [failed, setFailed] = useState<string[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    api
      .myProfile(token)
      .then((p) => setMe(p.id))
      .catch(() => setMe(null));
  }, [token]);

  // Re-read only when the set of workspaces changes, not on every new array.
  const key = workspaces.map((w) => w.id).join(",");
  useEffect(() => {
    let live = true;
    (async () => {
      let known = true;
      const errors: string[] = [];
      const [perPulls, perReviews, myMarks] = await Promise.all([
        Promise.all(
          workspaces.map(async (ws) => {
            try {
              const items: OpenPullRequest[] = [];
              for (let offset = 0; ; ) {
                const page = await api.pullRequestsWaitingOnMe(token, ws.id, offset);
                items.push(...page.items);
                known = known && page.members_known;
                offset += page.items.length;
                if (page.items.length === 0 || offset >= page.total) break;
              }
              return { workspace: ws.id, items: myPullsInOrder(items) };
            } catch (e) {
              errors.push(`${ws.name}: ${errText(e)}`);
              return { workspace: ws.id, items: [] };
            }
          }),
        ),
        // A backend from before reviews answers 404: there are simply none.
        Promise.all(
          workspaces.map(async (ws) => ({
            workspace: ws.id,
            items: await api
              .reviewRequestsWaitingOnMe(token, ws.id)
              .then((r) => r.items)
              .catch(() => [] as ReviewRequest[]),
          })),
        ),
        api.inboxMarks(token).catch(() => [] as InboxMark[]),
      ]);
      if (!live) return;
      setPulls(perPulls);
      setReviews(perReviews);
      setMarks(myMarks);
      setMembersKnown(known);
      setFailed(errors);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, key, tick]);

  // A review asked of the reader, or decided on what they asked: read again.
  useEffect(() => {
    if (!me) return;
    let timer: number | undefined;
    const unsubscribe = subscribeStudioEvents(token, {
      onEvent: (frame) => {
        if (!concernsMe(frame, me)) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setTick((t) => t + 1), 300);
      },
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [token, me]);

  const { open, hidden } = useMemo(
    () => inboxItems(reviews, pulls ?? [], marks, new Date()),
    [reviews, pulls, marks],
  );

  const mark = useCallback(
    async (item: InboxItem, state: "done" | "snoozed" | "open") => {
      const until = state === "snoozed" ? snoozeUntil(new Date(), 1) : null;
      // Shown at once; the server's answer replaces it.
      setMarks((all) => [
        { item_key: item.key, state, until, updated_at: new Date().toISOString() },
        ...all.filter((m) => m.item_key !== item.key),
      ]);
      try {
        await api.markInboxItem(token, item.key, state, until);
      } catch {
        setTick((t) => t + 1);
      }
    },
    [token],
  );

  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "";
  const wsOf = (id: string) => workspaces.find((w) => w.id === id);
  const reviewCount = open.filter((i) => i.kind === "review").length;
  const pullCount = open.length - reviewCount;

  return (
    <div className="card span-all prw">
      <div className="card-head">
        <h2>Waiting on you</h2>
        {open.length > 0 && (
          <span className="hint">
            {[reviewCount && `${reviewCount} review${reviewCount === 1 ? "" : "s"}`, pullCount && `${pullCount} pull request${pullCount === 1 ? "" : "s"}`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </div>
      <p className="hint">
        Reviews somebody asked you for, and open pull requests in your projects whose next step is yours — overdue
        first. Done or snoozed items stay away until they change.
      </p>
      {pulls === null ? (
        <p className="empty">Reading what waits for you…</p>
      ) : open.length === 0 ? (
        <p className="empty">
          {failed.length === workspaces.length && failed.length > 0
            ? `Pull requests could not be read: ${failed[0]}`
            : hidden > 0
              ? `Nothing new. ${hidden} item${hidden === 1 ? " is" : "s are"} done or snoozed.`
              : myEmptyMessage({ membersKnown, workspaces: workspaces.length })}
        </p>
      ) : (
        <ul className="rows">
          {open.map((item) => (
            <li key={item.key}>
              <div className="grow">
                {item.kind === "review" ? (
                  <>
                    <div className="name">
                      Review <b>{item.review.title}</b>
                    </div>
                    <div className="sub">
                      {wsName(item.workspace)} · asked by {item.review.requested_by_name ?? "a colleague"}
                      {item.due && <> · due {item.due.slice(0, 10)}</>}
                      {item.overdue && <span className="badge warn prw-quiet">overdue</span>}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="name">
                      {item.pull.url ? (
                        <a href={item.pull.url} target="_blank" rel="noreferrer">
                          {item.pull.title}
                        </a>
                      ) : (
                        item.pull.title
                      )}
                    </div>
                    <div className="sub">
                      {wsName(item.workspace)} · {prRef(item.pull)} · {item.pull.reason}
                    </div>
                    <div className="sub">
                      {ageLine(item.pull)}
                      {isQuiet(item.pull) && <span className="badge warn prw-quiet">quiet</span>}
                    </div>
                  </>
                )}
              </div>
              {item.kind === "pull" ? (
                <span className={`badge ${WAITING_TONE[item.pull.waiting]}`} title={WAITING_SENTENCE[item.pull.waiting]}>
                  {MY_LABEL[item.pull.waiting]}
                </span>
              ) : (
                <button
                  className="linklike"
                  onClick={() => {
                    const ws = wsOf(item.workspace);
                    if (ws) onOpenWorkspace(ws);
                  }}
                >
                  Open project →
                </button>
              )}
              <span className="wo-marks">
                <button className="linklike" title="Hide it until it changes" onClick={() => void mark(item, "done")}>
                  Done
                </button>
                <button className="linklike" title="Hide it until this time tomorrow" onClick={() => void mark(item, "snoozed")}>
                  Snooze 1 day
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && open.length > 0 && (
        <p className="hint">
          {hidden} done or snoozed.{" "}
          <button className="linklike" onClick={() => setShowHidden((s) => !s)}>
            {showHidden ? "Keep them hidden" : "Bring them back"}
          </button>
          {showHidden && (
            <button
              className="linklike"
              style={{ marginLeft: 8 }}
              onClick={() => {
                for (const m of marks) void api.markInboxItem(token, m.item_key, "open", null);
                setMarks([]);
                setShowHidden(false);
              }}
            >
              Unmark all
            </button>
          )}
        </p>
      )}
      {pulls !== null && open.length > 0 && failed.length > 0 && (
        <p className="hint">Some projects could not be read: {failed.join("; ")}</p>
      )}
    </div>
  );
}
