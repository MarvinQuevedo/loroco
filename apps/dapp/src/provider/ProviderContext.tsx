// Global provider state: detection, connection, account/chain, live events.
//
// Connection flow honours the least-privilege scope from the plan: we call
// connect({scope}) FIRST (the only method that carries a scope), then read
// accounts/getAddress WITHOUT prompting (the grant already covers reads).

import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChainId } from "@ozone/goby-provider/types";
import { call, detectProvider } from "./client";

export type ProviderStatus = "detecting" | "absent" | "present";
export type ConnectScope = "full" | "read-only";

export interface ProviderContextValue {
  status: ProviderStatus;
  connected: boolean;
  /** Scope we requested at connect time (the wallet may clamp lower). */
  scope: ConnectScope | null;
  account: string | null;
  accounts: string[];
  chainId: ChainId | null;
  connecting: boolean;
  connect: (scope?: ConnectScope) => Promise<void>;
  /** Clears local connection UI state (there is no provider-side disconnect). */
  forgetLocal: () => void;
  refresh: () => Promise<void>;
  call: typeof call;
}

const noop = async () => {};
export const ProviderContext = createContext<ProviderContextValue>({
  status: "detecting",
  connected: false,
  scope: null,
  account: null,
  accounts: [],
  chainId: null,
  connecting: false,
  connect: noop,
  forgetLocal: () => {},
  refresh: noop,
  call,
});

const DETECT_INTERVAL_MS = 150;
const DETECT_TIMEOUT_MS = 6000;

export function ProviderProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ProviderStatus>("detecting");
  const [connected, setConnected] = useState(false);
  const [scope, setScope] = useState<ConnectScope | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<ChainId | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Read accounts + chain without prompting. Assumes a prior grant exists.
  const refresh = useCallback(async () => {
    try {
      const cid = await call("chainId");
      setChainId(cid);
    } catch {
      /* read failed — leave chainId as-is */
    }
    let list: string[] = [];
    try {
      list = await call("accounts");
    } catch {
      list = [];
    }
    if (list.length === 0) {
      try {
        const { address } = await call("getAddress");
        if (address) list = [address];
      } catch {
        /* no address available */
      }
    }
    setAccounts(list);
    setAccount(list[0] ?? null);
  }, []);

  const connect = useCallback(
    async (requested: ConnectScope = "full") => {
      setConnecting(true);
      try {
        // connect() is the only method carrying a scope. It pops the approval.
        const ok = await call("connect", { scope: requested });
        if (!ok) throw new Error("Connection rejected");
        setConnected(true);
        setScope(requested);
        await refresh();
      } finally {
        setConnecting(false);
      }
    },
    [refresh],
  );

  const forgetLocal = useCallback(() => {
    setConnected(false);
    setScope(null);
    setAccounts([]);
    setAccount(null);
  }, []);

  // ── Detection poll ────────────────────────────────────────────────────
  const detectedRef = useRef(false);
  useEffect(() => {
    if (detectProvider()) {
      detectedRef.current = true;
      setStatus("present");
      return;
    }
    const started = Date.now();
    const t = setInterval(() => {
      if (detectProvider()) {
        detectedRef.current = true;
        setStatus("present");
        clearInterval(t);
      } else if (Date.now() - started > DETECT_TIMEOUT_MS) {
        setStatus("absent");
        clearInterval(t);
      }
    }, DETECT_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  // ── Auto-restore: a prior origin grant survives (7d sliding expiry), so
  //    probe accounts once the provider is present. accounts throws when the
  //    origin isn't connected — that just means "show the connect gate".
  useEffect(() => {
    if (status !== "present") return;
    let cancelled = false;
    (async () => {
      try {
        const list = await call("accounts");
        if (cancelled || list.length === 0) return;
        setConnected(true);
        setScope("full");
        setAccounts(list);
        setAccount(list[0] ?? null);
        try {
          setChainId(await call("chainId"));
        } catch {
          /* ignore */
        }
      } catch {
        /* not connected — leave gate up */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  // ── Live events ──────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "present") return;
    const p = detectProvider();
    if (!p) return;

    const onChain = (payload: unknown) => {
      const cid = (payload as { chainId?: ChainId } | undefined)?.chainId;
      if (cid) setChainId(cid);
    };
    // accountChanged payload is undefined by design → re-fetch.
    const onAccount = () => {
      void refresh();
    };

    p.on("chainChanged", onChain);
    p.on("accountChanged", onAccount);
    return () => {
      p.off?.("chainChanged", onChain);
      p.off?.("accountChanged", onAccount);
    };
  }, [status, refresh]);

  const value = useMemo<ProviderContextValue>(
    () => ({
      status,
      connected,
      scope,
      account,
      accounts,
      chainId,
      connecting,
      connect,
      forgetLocal,
      refresh,
      call,
    }),
    [status, connected, scope, account, accounts, chainId, connecting, connect, forgetLocal, refresh],
  );

  return <ProviderContext.Provider value={value}>{children}</ProviderContext.Provider>;
}
