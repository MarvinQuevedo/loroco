import { useState } from "react";
import { PageHead } from "../../components/layout/AppShell";
import {
  ApprovalWait,
  Button,
  Card,
  CopyText,
  EmptyState,
  Field,
  JsonView,
  Spinner,
  TextInput,
  TxResult,
} from "../../components/ui";
import { useCall } from "../../provider/useProvider";
import { useWriteAction } from "../../provider/useWriteAction";
import { useCats } from "../../provider/useCats";
import { catToMojos, mojosToCat, xchToMojos } from "../../lib/mojos";
import { shortenHex } from "../../lib/format";
import { isHex32 } from "../../lib/hex";

export default function Tokens() {
  return (
    <>
      <PageHead title="Tokens" blurb="CAT balances, lookup, issuance and watch-list." />
      <CatsCard />
      <LookupCard />
      <IssueCatCard />
      <WatchAssetCard />
    </>
  );
}

function CatsCard() {
  const { cats, loaded, loading, reload } = useCats();
  return (
    <Card
      title="Owned CATs"
      actions={
        <Button variant="ghost" size="sm" loading={loading} onClick={() => void reload()}>
          ↻ Refresh
        </Button>
      }
    >
      {!loaded ? (
        <Spinner label="Reading CATs… (Dexie metadata can lag right after unlock)" />
      ) : cats.length === 0 ? (
        <EmptyState icon="🪙" title="No CATs">
          This wallet holds no CAT coins yet — issue one below or receive some.
        </EmptyState>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl" data-testid="cats-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Asset id</th>
                <th className="num">Balance</th>
                <th className="num">Coins</th>
              </tr>
            </thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.assetId}>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {c.iconUrl ? (
                        <img
                          src={c.iconUrl}
                          alt=""
                          width={22}
                          height={22}
                          style={{ borderRadius: "50%" }}
                        />
                      ) : (
                        <span aria-hidden>🪙</span>
                      )}
                      <strong>{c.symbol || c.name || "Unknown CAT"}</strong>
                      {c.name && c.symbol && (
                        <span style={{ color: "var(--muted)", fontSize: 12 }}>{c.name}</span>
                      )}
                    </span>
                  </td>
                  <td>
                    <CopyText text={c.assetId} display={shortenHex(c.assetId)} />
                  </td>
                  <td className="num mono">{mojosToCat(c.balance)}</td>
                  <td className="num">{c.coinCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function LookupCard() {
  const lookup = useCall("getToken");
  const [assetId, setAssetId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const run = async () => {
    setFormError(null);
    if (!isHex32(assetId)) {
      setFormError("Asset id must be 32 bytes of hex (64 chars)");
      return;
    }
    await lookup.run({ assetId: assetId.trim() }).catch(() => {});
  };

  return (
    <Card title="Token lookup">
      <div className="row-line">
        <span className="grow">
          <TextInput
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
            placeholder="Asset id (64-char hex)"
            spellCheck={false}
          />
        </span>
        <Button onClick={() => void run()} loading={lookup.loading}>
          Lookup
        </Button>
      </div>
      {formError && <div className="note danger">{formError}</div>}
      {lookup.error && <div className="note danger">{lookup.error}</div>}
      {lookup.result === null && !lookup.loading && !lookup.error && assetId !== "" && (
        <div className="note warn" style={{ marginBottom: 0 }}>
          The wallet doesn't track this asset.
        </div>
      )}
      {lookup.result && (
        <>
          <div className="note success">
            <strong>
              {lookup.result.symbol || lookup.result.name || "Unknown CAT"}
            </strong>{" "}
            — balance {mojosToCat(lookup.result.balance)} across {lookup.result.coinCount} coin(s)
          </div>
          <JsonView value={lookup.result} />
        </>
      )}
    </Card>
  );
}

function IssueCatCard() {
  const action = useWriteAction("issueCat", {
    successMsg: (r) => `CAT issued — asset ${shortenHex(r.assetId)}`,
  });
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    setFormError(null);
    try {
      if (!/^(xch|txch)1[a-z0-9]{20,}$/.test(recipient.trim())) {
        throw new Error("Recipient doesn't look like a bech32m XCH address");
      }
      const mojos = catToMojos(amount);
      if (mojos <= 0n) throw new Error("Supply must be greater than zero");
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      await action
        .run({
          recipientAddress: recipient.trim(),
          amount: mojos.toString(),
          ...(feeMojos > 0n ? { fee: feeMojos.toString() } : {}),
        })
        .catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Issue a new CAT">
      <div className="note info" style={{ marginTop: 0 }}>
        Single-issuance TAIL (GenesisByCoinId) — the supply is minted once and can never be
        re-issued. The XCH backing it (1 CAT = 1000 mojos) comes from your wallet.
      </div>
      <div className="form-grid">
        <div className="span-2">
          <Field label="Initial owner address">
            <TextInput
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="xch1…"
              spellCheck={false}
              disabled={action.busy}
            />
          </Field>
        </div>
        <Field label="Supply (CAT)" hint="3 decimals — 1 CAT = 1000 CAT mojos.">
          <TextInput
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1000"
            inputMode="decimal"
            disabled={action.busy}
          />
        </Field>
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
      <ApprovalWait active={action.busy} label="Confirm the CAT issuance in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <TxResult id={action.result.id} title="CAT issued">
          <div style={{ marginTop: 6 }}>
            New asset id: <CopyText text={action.result.assetId} display={shortenHex(action.result.assetId)} />
          </div>
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

function WatchAssetCard() {
  const action = useWriteAction("walletWatchAsset", { successMsg: "Asset added to the wallet watch-list" });
  const [assetId, setAssetId] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    setFormError(null);
    try {
      if (!isHex32(assetId)) throw new Error("Asset id must be 32 bytes of hex (64 chars)");
      if (!symbol.trim()) throw new Error("Symbol is required");
      await action
        .run({
          type: "cat",
          options: {
            assetId: assetId.trim(),
            symbol: symbol.trim(),
            ...(logo.trim() ? { logo: logo.trim() } : {}),
          },
        })
        .catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Watch an asset">
      <div className="form-grid">
        <div className="span-2">
          <Field label="Asset id">
            <TextInput
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              placeholder="64-char hex"
              spellCheck={false}
              disabled={action.busy}
            />
          </Field>
        </div>
        <Field label="Symbol">
          <TextInput
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="e.g. SBX"
            disabled={action.busy}
          />
        </Field>
        <Field label="Logo URL" hint="Optional.">
          <TextInput
            value={logo}
            onChange={(e) => setLogo(e.target.value)}
            placeholder="https://…"
            disabled={action.busy}
          />
        </Field>
      </div>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Confirm the watch request in the Loroco popup…" />
      {action.phase === "success" && (
        <div className="note success">✓ The wallet is now tracking this asset.</div>
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy}>
          Review in wallet →
        </Button>
      </div>
    </Card>
  );
}
