import { useState } from "react";
import { PageHead } from "../../components/layout/AppShell";
import {
  ApprovalWait,
  Button,
  Card,
  Field,
  JsonView,
  TextInput,
  TxResult,
} from "../../components/ui";
import { AssetSelect } from "../../components/AssetSelect";
import {
  RecipientRows,
  emptyRow,
  rowsToOutputs,
  rowsTotal,
  type OutRow,
} from "../../components/RecipientRows";
import { useWriteAction } from "../../provider/useWriteAction";
import { useCats } from "../../provider/useCats";
import { CAT_DECIMALS, XCH_DECIMALS, baseToDecimal, xchToMojos } from "../../lib/mojos";

// Three independent flows, each with its own approval lifecycle:
//   bulkSendXch — N×XCH in one bundle
//   bulkSendCat — one CAT to N recipients
//   multiSend   — XCH + one CAT, atomic (assert_concurrent_spend)
// combine/split are wallet-only (4004) — noted, not callable from here.
export default function Batch() {
  return (
    <>
      <PageHead
        title="Batch"
        blurb="Multi-recipient sends and atomic XCH+CAT bundles — one approval, one spend bundle."
      />
      <BulkXchCard />
      <BulkCatCard />
      <MultiSendCard />
      <div className="note info">
        <code>combine</code> and <code>split</code> are wallet-only utilities (they return{" "}
        <code>4004</code> to dApps) — run them from the Loroco popup itself.
      </div>
    </>
  );
}

function FeeInput({
  fee,
  setFee,
  disabled,
}: {
  fee: string;
  setFee: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <Field label="Fee (XCH)" hint="Optional.">
      <TextInput
        value={fee}
        onChange={(e) => setFee(e.target.value)}
        placeholder="0"
        inputMode="decimal"
        disabled={disabled}
      />
    </Field>
  );
}

function txIdOf(result: unknown): string | null {
  return result && typeof result === "object" && "id" in result
    ? ((result as { id: string }).id ?? null)
    : null;
}

function BulkXchCard() {
  const action = useWriteAction("bulkSendXch", { successMsg: "Bulk XCH send broadcast 🚀" });
  const [rows, setRows] = useState<OutRow[]>([emptyRow()]);
  const [fee, setFee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const total = rowsTotal(rows, XCH_DECIMALS);

  const submit = async () => {
    setFormError(null);
    try {
      const outputs = rowsToOutputs(rows, XCH_DECIMALS);
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      await action
        .run({ outputs, ...(feeMojos > 0n ? { fee: feeMojos.toString() } : {}) })
        .catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Bulk send — XCH">
      <RecipientRows rows={rows} onChange={setRows} unit="XCH" disabled={action.busy} />
      <div className="form-grid" style={{ marginTop: 14 }}>
        <FeeInput fee={fee} setFee={setFee} disabled={action.busy} />
      </div>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Confirm the bulk XCH send in the Loroco popup…" />
      {action.phase === "success" && (
        <TxResult id={txIdOf(action.result)} title="Bulk XCH send submitted">
          <JsonView value={action.result} />
        </TxResult>
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy}>
          Review in wallet →
        </Button>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          Total: <strong>{baseToDecimal(total, XCH_DECIMALS)} XCH</strong> to{" "}
          {rows.filter((r) => r.address.trim()).length} recipient(s)
        </span>
      </div>
    </Card>
  );
}

function BulkCatCard() {
  const { cats } = useCats();
  const action = useWriteAction("bulkSendCat", { successMsg: "Bulk CAT send broadcast 🚀" });
  const [assetId, setAssetId] = useState("");
  const [rows, setRows] = useState<OutRow[]>([emptyRow()]);
  const [fee, setFee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const cat = cats.find((c) => c.assetId === assetId) ?? cats[0] ?? null;
  const effectiveId = assetId || cat?.assetId || "";
  const unit = cat?.symbol || "CAT";
  const total = rowsTotal(rows, CAT_DECIMALS);

  const submit = async () => {
    setFormError(null);
    try {
      if (!effectiveId) throw new Error("This wallet has no CATs to send");
      const outputs = rowsToOutputs(rows, CAT_DECIMALS);
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      await action
        .run({
          assetId: effectiveId,
          outputs,
          ...(feeMojos > 0n ? { fee: feeMojos.toString() } : {}),
        })
        .catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Bulk send — CAT">
      <div className="form-grid" style={{ marginBottom: 14 }}>
        <Field label="CAT asset">
          <AssetSelect
            cats={cats}
            value={effectiveId}
            onChange={setAssetId}
            catsOnly
            disabled={action.busy}
          />
        </Field>
        <FeeInput fee={fee} setFee={setFee} disabled={action.busy} />
      </div>
      <RecipientRows rows={rows} onChange={setRows} unit={unit} disabled={action.busy} />

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Confirm the bulk CAT send in the Loroco popup…" />
      {action.phase === "success" && (
        <TxResult id={txIdOf(action.result)} title="Bulk CAT send submitted">
          <JsonView value={action.result} />
        </TxResult>
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy} disabled={!effectiveId}>
          Review in wallet →
        </Button>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          Total: <strong>{baseToDecimal(total, CAT_DECIMALS)} {unit}</strong>
        </span>
      </div>
    </Card>
  );
}

function MultiSendCard() {
  const { cats } = useCats();
  const action = useWriteAction("multiSend", { successMsg: "Atomic multi-send broadcast 🚀" });
  const [xchRows, setXchRows] = useState<OutRow[]>([emptyRow()]);
  const [includeCat, setIncludeCat] = useState(false);
  const [assetId, setAssetId] = useState("");
  const [catRows, setCatRows] = useState<OutRow[]>([emptyRow()]);
  const [fee, setFee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const cat = cats.find((c) => c.assetId === assetId) ?? cats[0] ?? null;
  const effectiveId = assetId || cat?.assetId || "";

  const submit = async () => {
    setFormError(null);
    try {
      const hasXch = xchRows.some((r) => r.address.trim() || r.amount.trim());
      const params: {
        xchOutputs?: Array<{ address: string; amount: string }>;
        catOutputs?: { assetId: string; outputs: Array<{ address: string; amount: string }> };
        fee?: string;
      } = {};
      if (hasXch) params.xchOutputs = rowsToOutputs(xchRows, XCH_DECIMALS);
      if (includeCat) {
        if (!effectiveId) throw new Error("Pick a CAT asset for the CAT leg");
        params.catOutputs = { assetId: effectiveId, outputs: rowsToOutputs(catRows, CAT_DECIMALS) };
      }
      if (!params.xchOutputs && !params.catOutputs) {
        throw new Error("Add at least one XCH or CAT output");
      }
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      if (feeMojos > 0n) params.fee = feeMojos.toString();
      await action.run(params).catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Atomic multi-send — XCH + one CAT">
      <div className="note info" style={{ marginTop: 0 }}>
        Both legs ride one spend bundle tied with <code>assert_concurrent_spend</code> — a partial
        broadcast is impossible.
      </div>

      <Field label="XCH outputs">
        <RecipientRows rows={xchRows} onChange={setXchRows} unit="XCH" disabled={action.busy} />
      </Field>

      <div style={{ margin: "14px 0" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={includeCat}
            onChange={(e) => setIncludeCat(e.target.checked)}
            disabled={action.busy}
          />
          Include a CAT leg
        </label>
      </div>

      {includeCat && (
        <>
          <div className="form-grid" style={{ marginBottom: 14 }}>
            <Field label="CAT asset">
              <AssetSelect
                cats={cats}
                value={effectiveId}
                onChange={setAssetId}
                catsOnly
                disabled={action.busy}
              />
            </Field>
          </div>
          <Field label={`${cat?.symbol || "CAT"} outputs`}>
            <RecipientRows
              rows={catRows}
              onChange={setCatRows}
              unit={cat?.symbol || "CAT"}
              disabled={action.busy}
            />
          </Field>
        </>
      )}

      <div className="form-grid" style={{ marginTop: 14 }}>
        <FeeInput fee={fee} setFee={setFee} disabled={action.busy} />
      </div>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Confirm the atomic bundle in the Loroco popup…" />
      {action.phase === "success" && (
        <TxResult id={txIdOf(action.result)} title="Atomic multi-send submitted">
          <JsonView value={action.result} />
        </TxResult>
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy}>
          Review in wallet →
        </Button>
      </div>
    </Card>
  );
}
