/**
 * Studio AI — the floating assistant shown in every product mockup.
 *
 * Real, not a mock: it talks to the mini-chat gear (createChat + streamMessage).
 * A single chat is created lazily on first question and reused, so the widget
 * keeps a short thread without spamming the backend. Read-only context for now —
 * it answers about what the portal shows; it does not act on the user's behalf.
 *
 * Styling lives in styles.css under `.studio-ai`. Mounted once in the app shell
 * (App.tsx) so it floats bottom-right over whatever screen is open.
 */
import { useState } from "react";
import { api } from "./api";

export function StudioAI({ token }: { token: string }) {
  const [open, setOpen] = useState(true);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const ask = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    setErr(null);
    setAnswer("");
    try {
      let id = chatId;
      if (!id) {
        const c = await api.createChat(token, "Portal assistant");
        id = c.id;
        setChatId(id);
      }
      await api.streamMessage(token, id, content, (full) => setAnswer(full));
    } catch {
      // mini-chat can be absent (no LLM key) or the token can lapse — say so
      // plainly instead of a spinner that never resolves.
      setErr("Studio AI is unavailable right now.");
    } finally {
      setBusy(false);
    }
  };

  const send = (text: string) => {
    setQ("");
    void ask(text);
  };

  if (!open) {
    return (
      <div className="studio-ai collapsed">
        <div className="sa-head" style={{ cursor: "pointer" }} onClick={() => setOpen(true)}>
          <span className="sa-mark" aria-hidden>✦</span>
          <span className="sa-title">Studio AI</span>
        </div>
      </div>
    );
  }

  return (
    <div className="studio-ai">
      <div className="sa-head">
        <span className="sa-mark" aria-hidden>✦</span>
        <span className="sa-title">Studio AI</span>
        <button className="ghost" title="Minimise" onClick={() => setOpen(false)}>—</button>
      </div>

      <div className="sa-ctx">
        <div className="sa-ctx-label">Context · Studio portal · read-only</div>

        {answer === null && !err ? (
          <button className="sa-chip" onClick={() => send("What should I look at first?")}>
            ✦ What should I look at first?
          </button>
        ) : (
          <div
            style={{
              marginTop: 8,
              maxHeight: 220,
              overflowY: "auto",
              fontSize: 13.5,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              color: err ? "var(--destructive)" : "var(--foreground)",
            }}
          >
            {err ?? (answer || (busy ? "…" : ""))}
          </div>
        )}
      </div>

      <form
        className="sa-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(q);
        }}
      >
        <input
          placeholder="Ask Studio…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={busy}
        />
        <button className="sa-send" type="submit" disabled={busy || !q.trim()} title="Send">
          ↑
        </button>
      </form>
    </div>
  );
}
