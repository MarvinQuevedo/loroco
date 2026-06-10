import { useCallback, useEffect, useState } from "react";
import type { OfferView } from "@ozone/goby-provider/types";
import { PageHead } from "../../components/layout/AppShell";
import {
  ApprovalWait,
  Button,
  Card,
  CopyText,
  EmptyState,
  Field,
  Spinner,
  TextArea,
  TextInput,
  TxResult,
} from "../../components/ui";
import { AssetSelect } from "../../components/AssetSelect";
import { useProvider } from "../../provider/useProvider";
import { useWriteAction } from "../../provider/useWriteAction";
import { useCats } from "../../provider/useCats";
import { CAT_DECIMALS, XCH_DECIMALS, decimalToBase, xchToMojos } from "../../lib/mojos";
import { shortenHex, timeAgo } from "../../lib/format";

export default function Offers() {
  // Bump to make the list re-read (after create/take/cancel).
  const [listGen, setListGen] = useState(0);
  const refreshList = useCallback(() => setListGen((g) => g + 1), []);

  return (
    <>
      <PageHead title="Offers" blurb="Create, take, list and cancel offers." />
      <CreateOfferCard onDone={refreshList} />
      <TakeOfferCard onDone={refreshList} />
      <OffersListCard generation={listGen} onChanged={refreshList} />
    </>
  );
}

// ── Create ────────────────────────────────────────────────────────────────

interface OfferRow {
  assetId: string; // "" = XCH
  amount: string;
}

function OfferRows({
  rows,
  onChange,
  cats,
  disabled,
}: {
  rows: OfferRow[];
  onChange: (rows: OfferRow[]) => void;
  cats: ReturnType<typeof useCats>["cats"];
  disabled?: boolean;
}) {
  const update = (i: number, patch: Partial<OfferRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="row-list">
      {rows.map((row, i) => (
        <div className="row-line" key={i}>
          <span className="grow">
            <AssetSelect
              cats={cats}
              value={row.assetId}
              onChange={(assetId) => update(i, { assetId })}
              disabled={disabled}
            />
          </span>
          <span className="w-amount">
            <TextInput
              value={row.amount}
              onChange={(e) => update(i, { amount: e.target.value })}
              placeholder={row.assetId ? "CAT" : "XCH"}
              inputMode="decimal"
              disabled={disabled}
            />
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="row-remove"
            title="Remove line"
            disabled={disabled || rows.length === 1}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            ✕
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...rows, { assetId: "", amount: "" }])}
        >
          + Add asset
        </Button>
      </div>
    </div>
  );
}

function rowsToOfferAssets(rows: OfferRow[], side: string) {
  const filled = rows.filter((r) => r.amount.trim() !== "");
  if (filled.length === 0) throw new Error(`${side}: add at least one asset with an amount`);
  return filled.map((r, i) => {
    const mojos = decimalToBase(r.amount, r.assetId ? CAT_DECIMALS : XCH_DECIMALS);
    if (mojos <= 0n) throw new Error(`${side} line ${i + 1}: amount must be greater than zero`);
    return { assetId: r.assetId, amount: mojos.toString() };
  });
}

function CreateOfferCard({ onDone }: { onDone: () => void }) {
  const { cats } = useCats();
  const action = useWriteAction("createOffer", { successMsg: "Offer created" });
  const [offerRows, setOfferRows] = useState<OfferRow[]>([{ assetId: "", amount: "" }]);
  const [requestRows, setRequestRows] = useState<OfferRow[]>([{ assetId: "", amount: "" }]);
  const [fee, setFee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    setFormError(null);
    try {
      const offerAssets = rowsToOfferAssets(offerRows, "You give");
      const requestAssets = rowsToOfferAssets(requestRows, "You get");
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      await action
        .run({
          offerAssets,
          requestAssets,
          ...(feeMojos > 0n ? { fee: feeMojos.toString() } : {}),
        })
        .then(() => onDone())
        .catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Create an offer">
      {/* Wide two-column split — the asset selects need room to not truncate. */}
      <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <Field label="You give" hint="Locked from your wallet into the offer.">
          <OfferRows rows={offerRows} onChange={setOfferRows} cats={cats} disabled={action.busy} />
        </Field>
        <Field label="You get" hint="What a taker must pay you.">
          <OfferRows rows={requestRows} onChange={setRequestRows} cats={cats} disabled={action.busy} />
        </Field>
      </div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <Field label="Fee (XCH)" hint="Optional.">
          <TextInput
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            disabled={action.busy}
          />
        </Field>
      </div>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Confirm the offer in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <div className="note success">
          <strong>✓ Offer ready to share</strong>
          <div style={{ margin: "8px 0 4px" }}>
            id: <CopyText text={action.result.id} display={shortenHex(action.result.id)} />
          </div>
          <Field label="Offer string" hint="Paste it on dexie.space or send it to the taker.">
            <TextArea readOnly value={action.result.offer} rows={4} onFocus={(e) => e.currentTarget.select()} />
          </Field>
        </div>
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy}>
          Review in wallet →
        </Button>
      </div>
    </Card>
  );
}

// ── Take ──────────────────────────────────────────────────────────────────

function TakeOfferCard({ onDone }: { onDone: () => void }) {
  const action = useWriteAction("takeOffer", { successMsg: "Offer taken 🚀" });
  const [offer, setOffer] = useState("");
  const [fee, setFee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    setFormError(null);
    try {
      if (!offer.trim().startsWith("offer1")) {
        throw new Error("That doesn't look like an offer string (should start with offer1…)");
      }
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      await action
        .run({ offer: offer.trim(), ...(feeMojos > 0n ? { fee: feeMojos.toString() } : {}) })
        .then(() => onDone())
        .catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Take an offer">
      <Field
        label="Offer string"
        hint="The wallet decodes it and shows you exactly what you give and what you get — including verified royalties — before you approve."
      >
        <TextArea
          value={offer}
          onChange={(e) => setOffer(e.target.value)}
          placeholder="offer1…"
          rows={4}
          spellCheck={false}
          disabled={action.busy}
        />
      </Field>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <Field label="Fee (XCH)" hint="Optional.">
          <TextInput
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            disabled={action.busy}
          />
        </Field>
      </div>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Review what you give / get in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <TxResult id={action.result.id} title="Offer taken" />
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy} disabled={!offer.trim()}>
          Review in wallet →
        </Button>
      </div>
    </Card>
  );
}

// ── List / cancel ─────────────────────────────────────────────────────────

function OffersListCard({ generation, onChanged }: { generation: number; onChanged: () => void }) {
  const { call, connected } = useProvider();
  const cancelAction = useWriteAction("cancelOffer", { successMsg: "Offer cancelled" });
  const [offers, setOffers] = useState<OfferView[] | null>(null);
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    setError(null);
    try {
      setOffers(await call("getOffers", { limit: 200, offset: 0, includeCancelled }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [call, connected, includeCancelled]);

  useEffect(() => {
    void load();
  }, [load, generation]);

  const cancel = async (id: string, secure: boolean) => {
    setBusyId(id);
    try {
      await cancelAction.run({ id, secure });
      onChanged();
    } catch {
      /* toasted by the action */
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card
      title="Your offers"
      actions={
        <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
          <label style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={includeCancelled}
              onChange={(e) => setIncludeCancelled(e.target.checked)}
            />
            show cancelled
          </label>
          <Button variant="ghost" size="sm" loading={loading} onClick={() => void load()}>
            ↻ Refresh
          </Button>
        </span>
      }
    >
      {error && <div className="note danger">{error}</div>}
      <ApprovalWait
        active={cancelAction.busy}
        label="Confirm the cancellation in the Loroco popup…"
      />

      {offers === null ? (
        <Spinner label="Reading offers…" />
      ) : offers.length === 0 ? (
        <EmptyState icon="🤝" title="No offers tracked">
          Offers you create or take from this origin show up here.
        </EmptyState>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl" data-testid="offers-table">
            <thead>
              <tr>
                <th>Offer id</th>
                <th>Created</th>
                <th>Status</th>
                <th>Offer string</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.id}>
                  <td>
                    <CopyText text={o.id} display={shortenHex(o.id)} />
                  </td>
                  <td>{timeAgo(o.createdAt)}</td>
                  <td>
                    {o.cancelled ? (
                      <span className="tag tag-stub">cancelled</span>
                    ) : (
                      <span className="tag tag-read">active</span>
                    )}
                  </td>
                  <td>
                    <CopyText text={o.offer} display={`${o.offer.slice(0, 14)}…`} />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {!o.cancelled && (
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <Button
                          variant="danger"
                          size="sm"
                          loading={busyId === o.id && cancelAction.busy}
                          title="Broadcasts a spend that invalidates the offer on-chain"
                          onClick={() => void cancel(o.id, true)}
                        >
                          Cancel on-chain
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={busyId === o.id && cancelAction.busy}
                          title="Only forgets it locally — the offer stays valid if it was shared!"
                          onClick={() => void cancel(o.id, false)}
                        >
                          Remove locally
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="note warn" style={{ marginBottom: 0 }}>
        <strong>Remove locally</strong> does NOT invalidate a shared offer — anyone holding the
        string can still take it. Use <strong>Cancel on-chain</strong> to be safe.
      </div>
    </Card>
  );
}
