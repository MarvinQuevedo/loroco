import { useEffect, useState } from "react";
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
import { useProvider } from "../../provider/useProvider";
import { useWriteAction } from "../../provider/useWriteAction";
import { useCats } from "../../provider/useCats";
import {
  baseToDecimal,
  catToMojos,
  decimalToBase,
  mojosToCat,
  mojosToXch,
  xchToMojos,
  CAT_DECIMALS,
  XCH_DECIMALS,
} from "../../lib/mojos";
import { textToHex } from "../../lib/hex";

// transfer normalises `to ?? address` server-side; we always send canonical
// `to`. Amounts go over the wire as mojo strings (BigInt-safe).
export default function Send() {
  const { call, scope } = useProvider();
  const { cats } = useCats();
  const action = useWriteAction("transfer", { successMsg: "Transfer broadcast 🚀" });

  const [assetId, setAssetId] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("");
  const [memo, setMemo] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const isCat = assetId !== "";
  const selectedCat = cats.find((c) => c.assetId === assetId) ?? null;
  const unit = isCat ? selectedCat?.symbol || "CAT" : "XCH";

  // Live spendable balance for the selected asset — context before sending.
  const [spendable, setSpendable] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    setSpendable(null);
    call("getAssetBalance", { type: isCat ? "cat" : null, assetId: isCat ? assetId : null })
      .then((b) => {
        if (!gone) setSpendable(b.spendable);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [call, assetId, isCat, action.result]);

  const decimals = isCat ? CAT_DECIMALS : XCH_DECIMALS;
  const fillMax = () => {
    if (spendable != null) setAmount(baseToDecimal(spendable, decimals));
  };
  // Live "amount exceeds spendable" guard — caught before we bother the wallet.
  let exceedsBalance = false;
  if (spendable != null && amount.trim()) {
    try {
      exceedsBalance = decimalToBase(amount, decimals) > BigInt(spendable);
    } catch {
      /* mid-typing */
    }
  }

  const onSubmit = async () => {
    setFormError(null);
    let params: { to: string; amount: string; assetId: string | null; fee?: string; memos?: string[] };
    try {
      const trimmedTo = to.trim();
      if (!/^(xch|txch)1[a-z0-9]{20,}$/.test(trimmedTo)) {
        throw new Error("Recipient doesn't look like a bech32m XCH address (xch1…/txch1…)");
      }
      const mojos = isCat ? catToMojos(amount) : xchToMojos(amount);
      if (mojos <= 0n) throw new Error("Amount must be greater than zero");
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      params = {
        to: trimmedTo,
        amount: mojos.toString(),
        assetId: isCat ? assetId : null,
        ...(feeMojos > 0n ? { fee: feeMojos.toString() } : {}),
        ...(memo.trim() ? { memos: [textToHex(memo.trim())] } : {}),
      };
    } catch (e) {
      setFormError((e as Error).message);
      return;
    }
    // Provider errors surface via action.error + toast — nothing extra here.
    await action.run(params).catch(() => {});
  };

  const txId = action.result && "id" in action.result ? (action.result.id as string) : null;
  const readOnly = scope === "read-only";

  return (
    <>
      <PageHead title="Send" blurb="Single XCH or CAT transfer — one recipient, optional memo." />

      {readOnly && (
        <div className="note info">
          This connection is <strong>read-only</strong> — the wallet will refuse signing requests.
          Reconnect with full access to send.
        </div>
      )}

      <Card title="Transfer">
        <div className="form-grid">
          <Field
            label="Asset"
            hint={
              spendable != null
                ? `Spendable: ${isCat ? mojosToCat(spendable) : mojosToXch(spendable)} ${unit}`
                : "Reading spendable balance…"
            }
          >
            <AssetSelect cats={cats} value={assetId} onChange={setAssetId} disabled={action.busy} />
          </Field>
          <Field
            label={`Amount (${unit})`}
            hint={
              exceedsBalance ? (
                <span className="field-warn">Exceeds spendable balance.</span>
              ) : isCat ? (
                "3 decimals"
              ) : (
                "12 decimals"
              )
            }
          >
            <span className="input-wrap">
              <TextInput
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0"
                inputMode="decimal"
                disabled={action.busy}
              />
              {spendable != null && spendable !== "0" && (
                <button type="button" className="input-inline-btn" onClick={fillMax} disabled={action.busy}>
                  Max
                </button>
              )}
            </span>
          </Field>
          <div className="span-2">
            <Field label="Recipient address">
              <TextInput
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="xch1…"
                spellCheck={false}
                disabled={action.busy}
              />
            </Field>
          </div>
          <Field label="Fee (XCH)" hint="Optional — network fee, always paid in XCH.">
            <TextInput
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="0"
              inputMode="decimal"
              disabled={action.busy}
            />
          </Field>
          <Field label="Memo" hint="Optional — stored on-chain, hex-encoded.">
            <TextInput
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="e.g. invoice #42"
              disabled={action.busy}
            />
          </Field>
        </div>

        {formError && <div className="note danger">{formError}</div>}
        {action.error && <div className="note danger">{action.error}</div>}

        <ApprovalWait active={action.busy} label="Confirm the transfer in the Loroco popup…" />

        {action.phase === "success" && (
          <TxResult id={txId} title={`Sent ${amount} ${unit}`}>
            <JsonView value={action.result} />
          </TxResult>
        )}

        <div className="form-actions">
          <Button onClick={() => void onSubmit()} loading={action.busy} disabled={readOnly}>
            Review in wallet →
          </Button>
          {action.phase === "success" && (
            <Button
              variant="ghost"
              onClick={() => {
                action.reset();
                setAmount("");
                setMemo("");
              }}
            >
              New transfer
            </Button>
          )}
        </div>
      </Card>
    </>
  );
}
