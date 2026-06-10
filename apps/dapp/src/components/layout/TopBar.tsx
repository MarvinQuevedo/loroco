import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useProvider } from "../../provider/useProvider";
import { usePendingTx } from "../../provider/PendingTxContext";
import { getTheme, onThemeChange, toggleTheme } from "../../theme";
import { shortenAddress } from "../../lib/format";
import { CopyText } from "../ui";

export function TopBar() {
  const { account, chainId, scope } = useProvider();
  const { pending } = usePendingTx();
  const [theme, setTheme] = useState(getTheme());
  useEffect(() => onThemeChange(setTheme), []);

  const isTestnet = chainId !== null && chainId !== "mainnet";

  return (
    <div className="topbar">
      <span className={`pill ${isTestnet ? "testnet" : ""}`}>
        <span className="dot" />
        {chainId ?? "—"}
      </span>
      {pending.length > 0 && (
        <Link to="/activity" style={{ textDecoration: "none" }}>
          <span
            className="pill pending"
            title="Transactions broadcast but not yet confirmed — click to track in Activity"
            data-testid="pending-pill"
          >
            <span className="dot" />
            {pending.length} pending
          </span>
        </Link>
      )}
      {scope === "read-only" && (
        <span className="tag tag-read" title="This origin connected read-only">
          read-only
        </span>
      )}
      <span className="spacer" />
      {account && <CopyText text={account} display={shortenAddress(account)} />}
      <button
        type="button"
        className="icon-btn"
        title="Toggle theme"
        aria-pressed={theme === "dark"}
        onClick={() => setTheme(toggleTheme())}
      >
        {theme === "dark" ? "☀️" : "🌙"}
      </button>
    </div>
  );
}
