/* An organization's Costs section (issue #781).
 *
 * What its model calls and IDE sessions cost over a period, grouped by
 * project, person, model, source or who paid, with a switch for what people
 * spent on their own keys; and the price list those costs are priced with.
 * The records are quantities kept by the platform's usage collector; the money
 * is computed from the price list when the report is read, so changing a price
 * reprices the past too. */

import { useCallback, useEffect, useState } from "react";

import { ApiError, api, type CostGroup, type CostReport, type ModelPrice, type PriceList, type SessionPrice } from "./api";
import { GROUPS, PERIODS, blankModel, hours, money, periodRange, priceProblem, rowLabel, tokens, type Period } from "./costs";
import { errText } from "./format";

const CSS = `
.costs .cost-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 4px 0 12px; }
.costs .cost-controls label { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; }
.costs table { width: 100%; border-collapse: collapse; font-size: 13px; }
.costs th, .costs td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.costs th.num, .costs td.num { text-align: right; font-variant-numeric: tabular-nums; }
.costs tfoot td { font-weight: 600; border-bottom: none; }
.costs .cost-unpriced { color: var(--muted-foreground); font-size: 12px; }
.costs .price-grid input { width: 100%; box-sizing: border-box; }
.costs .price-grid input[type=number] { max-width: 110px; }
.costs .price-actions { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
`;

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function OrgCosts({ token, org, you }: { token: string; org: { id: string; name: string }; you?: string }) {
  const [prices, setPrices] = useState<PriceList | null>(null);
  const [report, setReport] = useState<CostReport | null>(null);
  const [period, setPeriod] = useState<Period>("this-month");
  const [group, setGroup] = useState<CostGroup>("project");
  const [personal, setPersonal] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The editor's working copy of the price list.
  const [models, setModels] = useState<ModelPrice[]>([]);
  const [session, setSession] = useState<SessionPrice | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadPrices = useCallback(() => {
    let live = true;
    api
      .prices(token, org.id)
      .then((p) => {
        if (!live) return;
        setPrices(p);
        setModels(p.models);
        setSession(p.session ?? null);
        setCurrency(p.currency || "USD");
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof ApiError && e.status === 404 ? "This Studio does not count costs yet (the backend predates them)." : errText(e));
      });
    return () => {
      live = false;
    };
  }, [token, org.id]);
  useEffect(loadPrices, [loadPrices]);

  useEffect(() => {
    if (!prices?.may_view_costs) return;
    let live = true;
    setLoading(true);
    api
      .costs(token, org.id, { ...periodRange(period), group_by: group, include_personal: personal })
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(errText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [token, org.id, prices?.may_view_costs, period, group, personal, prices]);

  const problem = priceProblem(models);
  const save = async () => {
    if (problem) return;
    setSaving(true);
    setNotice(null);
    try {
      const saved = await api.updatePrices(token, org.id, { currency, models, session });
      setPrices(saved);
      setNotice("Prices saved. The report below is priced with them, past usage included.");
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };
  const setModel = (i: number, patch: Partial<ModelPrice>) =>
    setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const editable = prices?.may_manage ?? false;

  return (
    <div className="costs" data-org-costs>
      <style>{CSS}</style>
      <h1>Costs</h1>
      <p className="subtitle">
        What {org.name}&apos;s model calls and IDE sessions cost. Usage is recorded as tokens and pod time; the money comes
        from the price list below, so a changed price reprices the past too.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="hint">{notice}</div>}

      {prices && !prices.may_view_costs && (
        <p className="hint">Only the organization&apos;s administrators, or people granted cost.view, see the costs.</p>
      )}

      {prices?.may_view_costs && (
        <section className="card" data-cost-report>
          <div className="cost-controls">
            <label>
              Period
              <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Period">
                {PERIODS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              By
              <select value={group} onChange={(e) => setGroup(e.target.value as CostGroup)} aria-label="Group by">
                {GROUPS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
            <label title="What people spent on keys in their own profiles or personal connections">
              <input type="checkbox" checked={personal} onChange={(e) => setPersonal(e.target.checked)} data-cost-personal />
              Include people&apos;s own keys
            </label>
            {loading && <span className="hint">Counting…</span>}
          </div>
          {report && report.rows.length === 0 && <p className="empty">Nothing was used in this period.</p>}
          {report && report.rows.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>{GROUPS.find((g) => g.id === group)?.label}</th>
                  <th className="num">Input</th>
                  <th className="num">Output</th>
                  <th className="num">Cache read</th>
                  <th className="num">Cache write</th>
                  <th className="num">Sessions</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.key || "-"} data-cost-row={r.key}>
                    <td>{rowLabel(r, group, you)}</td>
                    <td className="num">{tokens(r.input_tokens)}</td>
                    <td className="num">{tokens(r.output_tokens)}</td>
                    <td className="num">{tokens(r.cache_read_tokens)}</td>
                    <td className="num">{tokens(r.cache_write_tokens)}</td>
                    <td className="num">{hours(r.session_seconds)}</td>
                    <td className="num">
                      {money(r.cost, report.currency)}
                      {r.unpriced && <span className="cost-unpriced" title="Part of this row has no price"> *</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td colSpan={5} />
                  <td className="num" data-cost-total>
                    {money(report.total, report.currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
          {report && report.unpriced.length > 0 && (
            <p className="cost-unpriced" data-cost-unpriced>
              * No price for {report.unpriced.join(", ")}: counted above, not in the cost. Add a price below.
            </p>
          )}
        </section>
      )}

      {prices && (
        <section className="card" data-price-list>
          <h3>Price list</h3>
          <p className="hint">
            Per model, the price of a million tokens of each kind; for IDE sessions, an hour of a requested CPU core and
            GiB of memory. A model ending in * prices every model that starts with the rest.
          </p>
          <table className="price-grid">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th className="num">Input / 1M</th>
                <th className="num">Output / 1M</th>
                <th className="num">Cache read / 1M</th>
                <th className="num">Cache write / 1M</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody>
              {models.map((m, i) => (
                <tr key={i}>
                  <td>
                    <input value={m.provider} disabled={!editable} onChange={(e) => setModel(i, { provider: e.target.value })} aria-label="Provider" />
                  </td>
                  <td>
                    <input value={m.model} disabled={!editable} onChange={(e) => setModel(i, { model: e.target.value })} aria-label="Model" placeholder="claude-sonnet-5-5*" />
                  </td>
                  {(["input_per_mtok", "output_per_mtok", "cache_read_per_mtok", "cache_write_per_mtok"] as const).map((k) => (
                    <td key={k} className="num">
                      <input type="number" min={0} step="0.01" value={m[k]} disabled={!editable} onChange={(e) => setModel(i, { [k]: num(e.target.value) })} aria-label={k} />
                    </td>
                  ))}
                  {editable && (
                    <td>
                      <button type="button" className="ghost" onClick={() => setModels((ms) => ms.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {models.length === 0 && (
                <tr>
                  <td colSpan={editable ? 7 : 6} className="empty">
                    No model is priced: model calls are counted but cost nothing in the report.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="price-actions">
            <label>
              IDE session, per CPU core hour{" "}
              <input type="number" min={0} step="0.001" value={session?.cpu_core_hour ?? ""} disabled={!editable} placeholder="unpriced" onChange={(e) => setSession({ cpu_core_hour: num(e.target.value), memory_gib_hour: session?.memory_gib_hour ?? 0 })} aria-label="CPU core hour" />
            </label>
            <label>
              per GiB hour{" "}
              <input type="number" min={0} step="0.001" value={session?.memory_gib_hour ?? ""} disabled={!editable} placeholder="unpriced" onChange={(e) => setSession({ cpu_core_hour: session?.cpu_core_hour ?? 0, memory_gib_hour: num(e.target.value) })} aria-label="GiB hour" />
            </label>
            <label>
              Currency{" "}
              <input value={currency} disabled={!editable} maxLength={3} size={4} onChange={(e) => setCurrency(e.target.value.toUpperCase())} aria-label="Currency" />
            </label>
          </div>
          {editable && (
            <div className="price-actions">
              <button type="button" onClick={() => setModels((ms) => [...ms, blankModel()])}>
                Add a model
              </button>
              <button type="button" className="primary" disabled={saving || !!problem} onClick={() => void save()} data-price-save>
                {saving ? "Saving…" : "Save prices"}
              </button>
              {problem && <span className="error">{problem}</span>}
            </div>
          )}
          {!editable && <p className="hint">Only the organization&apos;s administrators, or people granted cost.manage, change prices.</p>}
        </section>
      )}
    </div>
  );
}
