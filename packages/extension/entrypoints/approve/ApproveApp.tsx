import { useEffect, useState } from "react";
import type { ApprovalMessage, ApprovalResponse, PendingRequest } from "../../src/background/approval";

const PARAMS = new URLSearchParams(window.location.search);
const REQUEST_ID = PARAMS.get("id") ?? "";

async function fetchPending(): Promise<PendingRequest | null> {
  const msg: ApprovalMessage = { from: "approval", kind: "fetch", id: REQUEST_ID };
  const res = (await chrome.runtime.sendMessage(msg)) as ApprovalResponse;
  if (!res.ok || !res.request) return null;
  return res.request;
}

async function decide(approved: boolean): Promise<void> {
  const msg: ApprovalMessage = { from: "approval", kind: "decide", id: REQUEST_ID, approved };
  await chrome.runtime.sendMessage(msg);
  window.close();
}

export function ApproveApp() {
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const r = await fetchPending();
      setRequest(r);
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <div className="ozone-popup">
        <main>
          <section className="screen">
            <p className="muted">Loading…</p>
          </section>
        </main>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="ozone-popup">
        <header className="ozone-header">
          <span className="ozone-logo">Loroco</span>
        </header>
        <main>
          <section className="screen">
            <h1>Request expired</h1>
            <p className="muted">
              This approval request is no longer pending. You can close this window.
            </p>
            <button onClick={() => window.close()}>Close</button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="ozone-popup">
      <header className="ozone-header">
        <span className="ozone-logo">Loroco</span>
        <span className="ozone-meta">{request.method}</span>
      </header>
      <main>
        <section className="screen">
          <h1>{titleForMethod(request.method)}</h1>
          <p className="muted">
            <strong>{request.origin}</strong> is requesting permission.
          </p>

          <SummaryFor request={request} />

          <details>
            <summary>Raw params</summary>
            <pre className="params-raw">
              {JSON.stringify(request.params, null, 2)}
            </pre>
          </details>

          <div className="row">
            <button onClick={() => void decide(false)}>Reject</button>
            <button onClick={() => void decide(true)} className="approve-btn">
              Approve
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function titleForMethod(method: string): string {
  switch (method) {
    case "connect":
    case "requestAccounts":
      return "Connect this site";
    case "signCoinSpends":
      return "Sign coin spends";
    case "signMessage":
    case "signMessageByAddress":
      return "Sign message";
    case "transfer":
      return "Send transfer";
    case "sendTransaction":
      return "Send transaction";
    case "createOffer":
      return "Create offer";
    case "takeOffer":
      return "Take offer";
    case "cancelOffer":
      return "Cancel offer";
    case "walletSwitchChain":
      return "Switch network";
    case "walletWatchAsset":
      return "Add custom token";
    default:
      return method;
  }
}

function SummaryFor({ request }: { request: PendingRequest }) {
  const params = request.params as Record<string, unknown> | null;

  switch (request.method) {
    case "connect":
    case "requestAccounts":
      return (
        <div className="permission-summary">
          <p className="muted">If you approve, this site will be allowed to:</p>
          <ul className="permission-list">
            <li>
              <span className="permission-icon ok" aria-hidden>✓</span>
              <span>See your XCH addresses + balances</span>
            </li>
            <li>
              <span className="permission-icon ok" aria-hidden>✓</span>
              <span>See your CATs, NFTs and ongoing offers</span>
            </li>
            <li>
              <span className="permission-icon warn" aria-hidden>!</span>
              <span>
                Request your approval each time it wants to{" "}
                <strong>sign</strong> or <strong>send</strong> a transaction
                (you'll see another popup like this)
              </span>
            </li>
            <li>
              <span className="permission-icon" aria-hidden>·</span>
              <span>
                Stay connected until you remove it from{" "}
                <strong>Settings → Connected sites</strong>
              </span>
            </li>
          </ul>
          <p className="muted small">
            Loroco never auto-connects new sites — approval is always explicit.
          </p>
        </div>
      );

    case "signMessage": {
      const message = params?.message;
      return (
        <div className="result">
          <div>
            <span className="muted">message (hex)</span>
            <code>{String(message ?? "")}</code>
          </div>
        </div>
      );
    }

    case "transfer": {
      const to = params?.to;
      const amount = params?.amount;
      const assetId = params?.assetId;
      const fee = params?.fee;
      return (
        <div className="result">
          <div>
            <span className="muted">to</span>
            <code>{String(to ?? "")}</code>
          </div>
          <div>
            <span className="muted">amount</span>
            <code>{String(amount ?? "")}</code>
          </div>
          <div>
            <span className="muted">asset id</span>
            <code>{String(assetId ?? "(XCH)")}</code>
          </div>
          {fee != null && (
            <div>
              <span className="muted">fee</span>
              <code>{String(fee)}</code>
            </div>
          )}
        </div>
      );
    }

    case "signMessageByAddress": {
      const message = params?.message;
      const address = params?.address;
      return (
        <div className="result">
          <div>
            <span className="muted">address</span>
            <code>{String(address ?? "")}</code>
          </div>
          <div>
            <span className="muted">message (hex)</span>
            <code>{String(message ?? "")}</code>
          </div>
        </div>
      );
    }

    case "cancelOffer": {
      const id = params?.id;
      const fee = params?.fee;
      const secure = params?.secure !== false;
      return (
        <div className="result">
          <div>
            <span className="muted">offer id</span>
            <code>{String(id ?? "")}</code>
          </div>
          <div>
            <span className="muted">mode</span>
            <code>{secure ? "secure (broadcast spend)" : "local-only"}</code>
          </div>
          {fee != null && (
            <div>
              <span className="muted">fee</span>
              <code>{String(fee)}</code>
            </div>
          )}
        </div>
      );
    }

    default:
      return null;
  }
}
