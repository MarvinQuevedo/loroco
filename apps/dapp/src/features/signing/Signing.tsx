import { useEffect, useState } from "react";
import type { Hex } from "@ozone/goby-provider/types";
import { PageHead } from "../../components/layout/AppShell";
import {
  ApprovalWait,
  Button,
  Card,
  CopyText,
  Field,
  JsonView,
  Select,
  TextArea,
  TextInput,
} from "../../components/ui";
import { useProvider } from "../../provider/useProvider";
import { useWriteAction } from "../../provider/useWriteAction";
import { isHex, textToHex } from "../../lib/hex";
import { shortenHex } from "../../lib/format";

export default function Signing() {
  return (
    <>
      <PageHead title="Signing" blurb="Sign arbitrary messages by public key or address." />
      <SignByKeyCard />
      <SignByAddressCard />
    </>
  );
}

function MessageInput({
  value,
  onChange,
  asHex,
  setAsHex,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  asHex: boolean;
  setAsHex: (b: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Field
      label={
        <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
          Message
          <label style={{ fontWeight: 400, textTransform: "none", display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={asHex} onChange={(e) => setAsHex(e.target.checked)} />
            already hex
          </label>
        </span>
      }
      hint={asHex ? "Sent as-is." : "UTF-8 text — hex-encoded before signing."}
    >
      <TextArea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={asHex ? "deadbeef…" : "Message to sign…"}
        rows={3}
        spellCheck={false}
        disabled={disabled}
      />
    </Field>
  );
}

function encodeMessage(value: string, asHex: boolean): string {
  const v = value.trim();
  if (!v) throw new Error("Message is empty");
  if (asHex) {
    if (!isHex(v)) throw new Error("Not valid even-length hex");
    return v.replace(/^0x/, "");
  }
  return textToHex(v);
}

function SignByKeyCard() {
  const { call, connected } = useProvider();
  const action = useWriteAction("signMessage", { successMsg: "Message signed" });
  const [keys, setKeys] = useState<Hex[]>([]);
  const [publicKey, setPublicKey] = useState("");
  const [message, setMessage] = useState("");
  const [asHex, setAsHex] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    call("getPublicKeys", { limit: 50, offset: 0 })
      .then((k) => {
        setKeys(k);
        setPublicKey((cur) => cur || k[0] || "");
      })
      .catch(() => setKeys([]));
  }, [call, connected]);

  const submit = async () => {
    setFormError(null);
    try {
      if (!publicKey) throw new Error("Pick a public key");
      await action.run({ message: encodeMessage(message, asHex), publicKey }).catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="signMessage — by public key">
      <div className="form-grid">
        <div className="span-2">
          <Field label="Public key" hint={`${keys.length} key(s) available from getPublicKeys.`}>
            <Select value={publicKey} onChange={(e) => setPublicKey(e.target.value)} disabled={action.busy}>
              {keys.length === 0 && <option value="">No keys</option>}
              {keys.map((k) => (
                <option key={k} value={k}>
                  {shortenHex(k, 16, 12)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="span-2">
          <MessageInput value={message} onChange={setMessage} asHex={asHex} setAsHex={setAsHex} disabled={action.busy} />
        </div>
      </div>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Approve the signature in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <div className="note success">
          <strong>✓ Signature (BLS)</strong>
          <div style={{ marginTop: 8 }}>
            <CopyText text={String(action.result)} display={shortenHex(String(action.result), 24, 18)} />
          </div>
        </div>
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy} disabled={keys.length === 0}>
          Review in wallet →
        </Button>
      </div>
    </Card>
  );
}

function SignByAddressCard() {
  const { account } = useProvider();
  const action = useWriteAction("signMessageByAddress", { successMsg: "Message signed" });
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState("");
  const [asHex, setAsHex] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Prefill with the connected address once known.
  useEffect(() => {
    setAddress((cur) => cur || account || "");
  }, [account]);

  const submit = async () => {
    setFormError(null);
    try {
      if (!/^(xch|txch)1[a-z0-9]{20,}$/.test(address.trim())) {
        throw new Error("Not a bech32m XCH address");
      }
      await action
        .run({ message: encodeMessage(message, asHex), address: address.trim() })
        .catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="signMessageByAddress — Chia Signed Message">
      <div className="note info" style={{ marginTop: 0 }}>
        Signs with the key whose puzzle derives this address, using the{" "}
        <code>"Chia Signed Message"</code> domain prefix (Sage-compatible).
      </div>
      <div className="form-grid">
        <div className="span-2">
          <Field label="Address">
            <TextInput
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="xch1…"
              spellCheck={false}
              disabled={action.busy}
            />
          </Field>
        </div>
        <div className="span-2">
          <MessageInput value={message} onChange={setMessage} asHex={asHex} setAsHex={setAsHex} disabled={action.busy} />
        </div>
      </div>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Approve the signature in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <div className="note success">
          <strong>✓ Signed</strong>
          <div style={{ marginTop: 8 }}>
            publicKey: <CopyText text={action.result.publicKey} display={shortenHex(action.result.publicKey, 16, 12)} />
          </div>
          <div style={{ marginTop: 6 }}>
            signature: <CopyText text={action.result.signature} display={shortenHex(action.result.signature, 24, 18)} />
          </div>
          <JsonView value={action.result} />
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
