// Ergonomic hooks over ProviderContext.

import { useCallback, useContext, useState } from "react";
import type { ChiaMethod, ChiaMethodMap } from "@ozone/goby-provider/types";
import { ProviderContext } from "./ProviderContext";
import { describeError } from "./client";

export function useProvider() {
  return useContext(ProviderContext);
}

interface CallState<M extends ChiaMethod> {
  loading: boolean;
  result: ChiaMethodMap[M]["result"] | null;
  error: string | null;
}

/**
 * Wrap a single provider method as a button-friendly action:
 *   const { run, loading, result, error } = useCall("getCats");
 *   await run({ limit: 20 });
 * `run` resolves to the result (or throws), and also stores it in `result`.
 */
export function useCall<M extends ChiaMethod>(method: M) {
  const { call } = useProvider();
  const [state, setState] = useState<CallState<M>>({
    loading: false,
    result: null,
    error: null,
  });

  const run = useCallback(
    async (params?: ChiaMethodMap[M]["params"]) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const result = await call(method, params);
        setState({ loading: false, result, error: null });
        return result;
      } catch (e) {
        setState({ loading: false, result: null, error: describeError(e) });
        throw e;
      }
    },
    [call, method],
  );

  const reset = useCallback(() => {
    setState({ loading: false, result: null, error: null });
  }, []);

  return { run, reset, ...state };
}
