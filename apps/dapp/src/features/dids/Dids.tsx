import { useCallback, useEffect, useState } from "react";
import type { DidInfo } from "@ozone/goby-provider/types";
import { PageHead } from "../../components/layout/AppShell";
import {
  ApprovalWait,
  Button,
  Card,
  CopyText,
  EmptyState,
  Field,
  Select,
  Spinner,
  TextInput,
  TxResult,
} from "../../components/ui";
import { useProvider } from "../../provider/useProvider";
import { useWriteAction } from "../../provider/useWriteAction";
import { shortenAddress, shortenHex } from "../../lib/format";
import { xchToMojos } from "../../lib/mojos";

export default function Dids() {
  const [gen, setGen] = useState(0);
  const refresh = useCallback(() => setGen((g) => g + 1), []);
  return (
    <>
      <PageHead title="DIDs" blurb="Decentralized IDs minted by this wallet." />
      <DidListCard generation={gen} />
      <CreateDidCard onDone={refresh} />
      <TransferDidCard generation={gen} onDone={refresh} />
      <div className="note info">
        <code>normalizeDids</code> is wallet-only (<code>4004</code> to dApps). Collection reads (
        <code>getNftCollections</code>, <code>getMinterDidIds</code>) return empty results until
        Fase 3 DID sync lands.
      </div>
    </>
  );
}

function useDids(generation: number) {
  const { call, connected } = useProvider();
  const [dids, setDids] = useState<DidInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    try {
      setDids(await call("getDids", { limit: 100, offset: 0 }));
    } catch {
      setDids([]);
    } finally {
      setLoading(false);
    }
  }, [call, connected]);

  useEffect(() => {
    void load();
  }, [load, generation]);

  return { dids, loading, reload: load };
}

function DidListCard({ generation }: { generation: number }) {
  const { dids, loading, reload } = useDids(generation);
  return (
    <Card
      title="Your DIDs"
      actions={
        <Button variant="ghost" size="sm" loading={loading} onClick={() => void reload()}>
          ↻ Refresh
        </Button>
      }
    >
      {dids === null ? (
        <Spinner label="Reading DIDs…" />
      ) : dids.length === 0 ? (
        <EmptyState icon="🪪" title="No DIDs tracked">
          DIDs minted by this wallet (createDid) show up here. A fresh DID's eve coin must confirm
          before it can mint NFTs or be transferred.
        </EmptyState>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl" data-testid="dids-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>DID address</th>
                <th>Launcher id</th>
                <th>Head coin</th>
                <th className="num">Key index</th>
              </tr>
            </thead>
            <tbody>
              {dids.map((d) => (
                <tr key={d.launcherId}>
                  <td>{d.name ?? <span style={{ color: "var(--muted)" }}>—</span>}</td>
                  <td>
                    <CopyText text={d.address} display={shortenAddress(d.address)} />
                  </td>
                  <td>
                    <CopyText text={d.launcherId} display={shortenHex(d.launcherId)} />
                  </td>
                  <td>
                    <CopyText text={d.coinId} display={shortenHex(d.coinId)} />
                  </td>
                  <td className="num">{d.derivationIndex ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CreateDidCard({ onDone }: { onDone: () => void }) {
  const action = useWriteAction("createDid", { successMsg: "DID created 🪪" });
  const [fee, setFee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    setFormError(null);
    try {
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      await action
        .run(feeMojos > 0n ? { fee: feeMojos.toString() } : {})
        .then(() => onDone())
        .catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Create a DID">
      <div className="note info" style={{ marginTop: 0 }}>
        Mints a simple-profile DID singleton (no recovery list, 1 verification). Costs 1 mojo plus
        the optional fee. The eve coin must confirm before the DID can act.
      </div>
      <div className="form-grid">
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
      <ApprovalWait active={action.busy} label="Confirm the DID mint in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <TxResult id={action.result.id} title="DID created">
          <div style={{ marginTop: 6 }}>
            DID id: <CopyText text={action.result.didId} display={shortenHex(action.result.didId)} />
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

function TransferDidCard({ generation, onDone }: { generation: number; onDone: () => void }) {
  const { dids } = useDids(generation);
  const action = useWriteAction("transferDid", { successMsg: "DID transfer broadcast" });
  const [didId, setDidId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [fee, setFee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const list = dids ?? [];
  const selected = list.find((d) => d.launcherId === didId) ?? list[0] ?? null;

  const submit = async () => {
    setFormError(null);
    try {
      if (!selected) throw new Error("No DID selected");
      if (selected.derivationIndex == null) {
        throw new Error("This DID has no derivation index tracked — only locally-minted DIDs can be transferred from here");
      }
      if (!/^(xch|txch)1[a-z0-9]{20,}$/.test(recipient.trim())) {
        throw new Error("Recipient doesn't look like a bech32m XCH address");
      }
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      await action
        .run({
          didCoinId: selected.coinId,
          didDerivationIndex: selected.derivationIndex,
          recipientAddress: recipient.trim(),
          ...(feeMojos > 0n ? { fee: feeMojos.toString() } : {}),
        })
        .then(() => onDone())
        .catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Transfer a DID">
      <div className="note warn" style={{ marginTop: 0 }}>
        Transferring gives the recipient full control of the DID — NFTs minted with it keep
        pointing at it.
      </div>
      <div className="form-grid">
        <Field label="DID">
          <Select
            value={selected?.launcherId ?? ""}
            onChange={(e) => setDidId(e.target.value)}
            disabled={action.busy || list.length === 0}
          >
            {list.length === 0 && <option value="">No DIDs available</option>}
            {list.map((d) => (
              <option key={d.launcherId} value={d.launcherId}>
                {d.name || shortenHex(d.launcherId)}
              </option>
            ))}
          </Select>
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
        <div className="span-2">
          <Field label="Recipient address">
            <TextInput
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="xch1…"
              spellCheck={false}
              disabled={action.busy}
            />
          </Field>
        </div>
      </div>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Confirm the DID transfer in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <TxResult id={action.result.id} title="DID transfer submitted" />
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy} disabled={list.length === 0}>
          Review in wallet →
        </Button>
      </div>
    </Card>
  );
}
