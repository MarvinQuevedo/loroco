import { useState } from "react";
import type { ChiaMethod, ChiaMethodMap, CoinSpend, SpendBundle } from "@ozone/goby-provider/types";
import { PageHead } from "../../components/layout/AppShell";
import {
  ApprovalWait,
  Button,
  Card,
  CopyText,
  Field,
  JsonView,
  TextArea,
  TextInput,
} from "../../components/ui";
import { useProvider } from "../../provider/useProvider";
import { useWriteAction } from "../../provider/useWriteAction";
import { describeError } from "../../provider/client";
import { FEATURES } from "../registry";
import { shortenHex } from "../../lib/format";

// Every method name the console knows about (for the datalist).
const ALL_METHODS = Array.from(
  new Set(FEATURES.flatMap((f) => f.methods.map((m) => m.name))),
).sort();

export default function Advanced() {
  return (
    <>
      <PageHead title="Advanced" blurb="Raw method console and blind-sign primitives." />
      <RawConsoleCard />
      <SignCoinSpendsCard />
      <SendTransactionCard />
    </>
  );
}

function RawConsoleCard() {
  const { call } = useProvider();
  const [method, setMethod] = useState("chainId");
  const [paramsText, setParamsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(undefined);
  const [elapsed, setElapsed] = useState<number | null>(null);

  const run = async () => {
    setError(null);
    setResult(undefined);
    setElapsed(null);
    let params: unknown;
    try {
      params = paramsText.trim() ? JSON.parse(paramsText) : undefined;
    } catch {
      setError("Params must be valid JSON (or empty)");
      return;
    }
    setLoading(true);
    const t0 = performance.now();
    try {
      const res = await call(
        method.trim() as ChiaMethod,
        params as ChiaMethodMap[ChiaMethod]["params"],
      );
      setResult(res === undefined ? null : res);
      setElapsed(Math.round(performance.now() - t0));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Raw method console">
      <div className="note warn" style={{ marginTop: 0 }}>
        Direct line to <code>provider.request()</code>. Mutating methods still pop the wallet
        approval — nothing here bypasses gating. Payloads over 4 MiB are rejected (<code>4029</code>).
      </div>
      <div className="form-grid">
        <Field label="Method" hint="Any chia_* / chip0002_* alias the router knows also works.">
          <TextInput
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            list="all-methods"
            spellCheck={false}
          />
          <datalist id="all-methods">
            {ALL_METHODS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <div className="span-2">
          <Field label="Params (JSON)">
            <TextArea
              value={paramsText}
              onChange={(e) => setParamsText(e.target.value)}
              placeholder='{"limit": 10, "offset": 0}'
              rows={4}
              spellCheck={false}
            />
          </Field>
        </div>
      </div>
      <div className="form-actions">
        <Button onClick={() => void run()} loading={loading}>
          Call
        </Button>
        {elapsed != null && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>↩ {elapsed} ms</span>
        )}
      </div>
      {error && <div className="note danger">{error}</div>}
      {result !== undefined && <JsonView value={result} label="Result" />}
    </Card>
  );
}

function SignCoinSpendsCard() {
  const action = useWriteAction("signCoinSpends", { successMsg: "Coin spends signed" });
  const [text, setText] = useState("");
  const [partialSign, setPartialSign] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    setFormError(null);
    let coinSpends: CoinSpend[];
    try {
      coinSpends = JSON.parse(text);
      if (!Array.isArray(coinSpends) || coinSpends.length === 0) {
        throw new Error("Expecting a non-empty JSON array of coin spends");
      }
    } catch (e) {
      setFormError(e instanceof SyntaxError ? "Invalid JSON" : (e as Error).message);
      return;
    }
    await action.run({ coinSpends, partialSign }).catch(() => {});
  };

  return (
    <Card title="signCoinSpends">
      <div className="note danger" style={{ marginTop: 0 }}>
        ⚠️ <strong>Blind-sign primitive.</strong> The wallet popup decodes conditions
        (AGG_SIG, announcements, unknown outputs) and requires an explicit acknowledgement —
        still, only sign bundles you built or fully understand.
      </div>
      <Field label="coinSpends (JSON array)" hint='[{"coin": {...}, "puzzle_reveal": "0x…", "solution": "0x…"}]'>
        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          spellCheck={false}
          disabled={action.busy}
        />
      </Field>
      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, margin: "10px 0", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={partialSign}
          onChange={(e) => setPartialSign(e.target.checked)}
          disabled={action.busy}
        />
        partialSign — don't fail on keys the wallet doesn't hold
      </label>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Review the decoded spend in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <div className="note success">
          <strong>✓ Aggregated BLS signature</strong>
          <div style={{ marginTop: 8 }}>
            <CopyText text={String(action.result)} display={shortenHex(String(action.result), 24, 18)} />
          </div>
        </div>
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy} disabled={!text.trim()}>
          Review in wallet →
        </Button>
      </div>
    </Card>
  );
}

function SendTransactionCard() {
  const action = useWriteAction("sendTransaction", { successMsg: "Spend bundle broadcast" });
  const [text, setText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    setFormError(null);
    let spendBundle: SpendBundle;
    try {
      spendBundle = JSON.parse(text);
      if (!spendBundle || !Array.isArray(spendBundle.coin_spends)) {
        throw new Error("Expecting {coin_spends: [...], aggregated_signature: '0x…'}");
      }
    } catch (e) {
      setFormError(e instanceof SyntaxError ? "Invalid JSON" : (e as Error).message);
      return;
    }
    await action.run({ spendBundle }).catch(() => {});
  };

  return (
    <Card title="sendTransaction">
      <div className="note danger" style={{ marginTop: 0 }}>
        ⚠️ Broadcasts a fully-signed bundle as-is. The wallet shows the decoded effect before you
        approve, but the bundle itself is your responsibility.
      </div>
      <Field label="spendBundle (JSON)">
        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          spellCheck={false}
          disabled={action.busy}
          placeholder='{"coin_spends": [...], "aggregated_signature": "0x…"}'
        />
      </Field>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Review the broadcast in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <div className="note success">
          <strong>✓ Submitted to the mempool</strong>
          <JsonView value={action.result} label="Inclusion status" />
        </div>
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy} disabled={!text.trim()}>
          Review in wallet →
        </Button>
      </div>
    </Card>
  );
}
