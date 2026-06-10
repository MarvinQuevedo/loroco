import { useState } from "react";
import { useProvider } from "../../provider/useProvider";
import type { ConnectScope } from "../../provider/ProviderContext";
import { describeError } from "../../provider/client";
import { Button } from "../ui";

// Shown when the provider is present but the origin has no grant yet.
export function ConnectGate() {
  const { connect, connecting } = useProvider();
  const [scope, setScope] = useState<ConnectScope>("full");
  const [error, setError] = useState<string | null>(null);

  const onConnect = async () => {
    setError(null);
    try {
      await connect(scope);
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="screen">
      <div className="screen-card">
        <img className="screen-logo" src="/icon.png" alt="Loroco" />
        <h1>Connect to Loroco</h1>
        <p style={{ color: "var(--muted)" }}>
          Approve a connection in the wallet popup. Every signing or spending
          action is re-approved per call — connecting alone never moves funds.
        </p>

        <div style={{ display: "grid", gap: 10, textAlign: "left", margin: "18px 0" }}>
          <ScopeOption
            value="full"
            current={scope}
            onSelect={setScope}
            title="Full access"
            desc="Reads plus the ability to request signing/spending (each one still prompts)."
          />
          <ScopeOption
            value="read-only"
            current={scope}
            onSelect={setScope}
            title="Read-only"
            desc="Balances, coins and history only. The wallet locks the grant — it can never be upgraded to signing."
          />
        </div>

        {error && <div className="note danger">{error}</div>}

        <Button onClick={onConnect} loading={connecting} style={{ width: "100%" }}>
          {connecting ? "Waiting for approval…" : "Connect"}
        </Button>
      </div>
    </div>
  );
}

function ScopeOption({
  value,
  current,
  onSelect,
  title,
  desc,
}: {
  value: ConnectScope;
  current: ConnectScope;
  onSelect: (s: ConnectScope) => void;
  title: string;
  desc: string;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className="card"
      style={{
        cursor: "pointer",
        textAlign: "left",
        borderColor: active ? "var(--orange)" : "var(--line)",
        outline: active ? "2px solid var(--orange)" : "none",
        boxShadow: "none",
        background: active ? "var(--active-bg)" : "var(--surface)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {active ? "● " : "○ "}
        {title}
      </div>
      <div style={{ fontSize: 13, color: "var(--muted)" }}>{desc}</div>
    </button>
  );
}
