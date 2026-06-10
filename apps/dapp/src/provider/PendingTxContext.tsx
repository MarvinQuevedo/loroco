// Global pending-transaction watcher.
//
// After any broadcast the user is otherwise blind until the next manual
// refresh. This context polls getPendingTransactions while connected
// (fast while something is pending, slow otherwise), surfaces the count
// to the TopBar pill, and toasts when a pending tx confirms — the
// "your transaction made it on-chain" moment.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TransactionView } from "@ozone/goby-provider/types";
import { useProvider } from "./useProvider";
import { useToast } from "../components/ui/Toast";
import { shortenHex } from "../lib/format";

interface PendingTxApi {
  pending: TransactionView[];
  /** Re-poll immediately (called right after a broadcast). */
  refreshNow: () => void;
}

const PendingTxCtx = createContext<PendingTxApi>({ pending: [], refreshNow: () => {} });

const FAST_MS = 5_000; // something is pending — watch closely
const SLOW_MS = 20_000; // idle background check

export function PendingTxProvider({ children }: { children: ReactNode }) {
  const { connected, call } = useProvider();
  const toast = useToast();
  const [pending, setPending] = useState<TransactionView[]>([]);
  // Bumping this restarts the poll loop (immediate poll + fresh schedule).
  const [generation, setGeneration] = useState(0);
  const prevIds = useRef<Set<string> | null>(null);

  const poll = useCallback(async () => {
    if (!connected) return;
    let list: TransactionView[] = [];
    try {
      list = await call("getPendingTransactions");
    } catch {
      return; // read-only hiccup — keep the previous snapshot
    }
    const ids = new Set(list.map((t) => t.id));
    // Anything that WAS pending and no longer is has confirmed (or was
    // re-orged out — rare enough that "confirmed" is the honest default).
    if (prevIds.current) {
      for (const id of prevIds.current) {
        if (!ids.has(id)) toast.push(`Transaction ${shortenHex(id)} confirmed ✓`, "success");
      }
    }
    prevIds.current = ids;
    setPending(list);
  }, [connected, call, toast]);

  // Self-rescheduling loop: fast cadence while a tx is in flight.
  useEffect(() => {
    if (!connected) {
      setPending([]);
      prevIds.current = null;
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await poll();
      if (cancelled) return;
      timer = setTimeout(tick, prevIds.current && prevIds.current.size > 0 ? FAST_MS : SLOW_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connected, poll, generation]);

  const refreshNow = useCallback(() => setGeneration((g) => g + 1), []);

  return <PendingTxCtx.Provider value={{ pending, refreshNow }}>{children}</PendingTxCtx.Provider>;
}

export function usePendingTx() {
  return useContext(PendingTxCtx);
}
