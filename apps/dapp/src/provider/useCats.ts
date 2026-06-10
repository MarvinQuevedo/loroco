// Shared CAT list — feeds every asset selector (Send, Batch, Tokens, Coins).
// getCats enriches via Dexie and can lag right after unlock, so callers get
// a `reload` to re-pull on demand.

import { useCallback, useEffect, useState } from "react";
import type { CatAssetView } from "@ozone/goby-provider/types";
import { useProvider } from "./useProvider";

export function useCats() {
  const { call, connected } = useProvider();
  const [cats, setCats] = useState<CatAssetView[] | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setCats(await call("getCats", { limit: 500, offset: 0 }));
    } catch {
      setCats((c) => c ?? []);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    if (connected) void reload();
  }, [connected, reload]);

  return { cats: cats ?? [], loaded: cats !== null, loading, reload };
}
