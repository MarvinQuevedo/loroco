// Write-call lifecycle with user-visible phases.
//
// Every mutating method goes through the wallet's per-call approval popup,
// so a write promise has three user-meaningful moments:
//   approving → the popup is up, nothing signed yet (show ApprovalWait)
//   success   → broadcast accepted, we have a tx id (show TxResult + toast)
//   error     → rejected in the wallet (4002) or failed (toast + note)
// This hook owns that state machine so feature pages never hand-roll it.

import { useCallback, useState } from "react";
import type { ChiaMethod, ChiaMethodMap } from "@ozone/goby-provider/types";
import { useProvider } from "./useProvider";
import { describeError, errCode } from "./client";
import { useToast } from "../components/ui/Toast";
import { usePendingTx } from "./PendingTxContext";

export type WritePhase = "idle" | "approving" | "success" | "error";

export interface WriteActionState<M extends ChiaMethod> {
  phase: WritePhase;
  result: ChiaMethodMap[M]["result"] | null;
  error: string | null;
  /** True while the wallet approval popup gates the call. */
  busy: boolean;
}

export function useWriteAction<M extends ChiaMethod>(
  method: M,
  opts?: {
    /** Toast on success. Default: "<method> sent". */
    successMsg?: string | ((result: ChiaMethodMap[M]["result"]) => string);
  },
) {
  const { call } = useProvider();
  const toast = useToast();
  const { refreshNow } = usePendingTx();
  const [state, setState] = useState<WriteActionState<M>>({
    phase: "idle",
    result: null,
    error: null,
    busy: false,
  });

  const run = useCallback(
    async (params?: ChiaMethodMap[M]["params"]) => {
      setState({ phase: "approving", result: null, error: null, busy: true });
      try {
        const result = await call(method, params);
        setState({ phase: "success", result, error: null, busy: false });
        const msg =
          typeof opts?.successMsg === "function"
            ? opts.successMsg(result)
            : opts?.successMsg ?? `${method} submitted`;
        toast.push(msg, "success");
        refreshNow(); // start watching the new pending tx immediately
        return result;
      } catch (e) {
        const rejected = errCode(e) === 4002;
        const error = describeError(e);
        setState({ phase: "error", result: null, error, busy: false });
        toast.push(rejected ? "Request rejected in the wallet" : error, rejected ? "info" : "error");
        throw e;
      }
    },
    [call, method, opts?.successMsg, toast, refreshNow],
  );

  const reset = useCallback(() => {
    setState({ phase: "idle", result: null, error: null, busy: false });
  }, []);

  return { run, reset, ...state };
}
