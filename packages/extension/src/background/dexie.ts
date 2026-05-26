// Dexie CAT metadata client.
//
// Dexie's public REST API exposes per-asset metadata for every CAT they
// index. The endpoint we use is:
//
//   GET https://api.dexie.space/v1/cats?ids=<asset_id_1>&ids=<asset_id_2>
//
// Response shape:
//   { "success": true, "cats": [
//       { "id": "...", "code": "DBX", "name": "dexie bucks", "denom": 1000 },
//       ...
//     ] }
//
// Icons are served at the convention:
//   https://icons.dexie.space/<asset_id>.webp
//
// We cache the metadata per asset_id in chrome.storage.local["dexie.cats"]
// with a 12 h TTL so a Dexie outage never blanks the wallet UI.

const CACHE_KEY = "dexie.cats";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export interface DexieCat {
  asset_id: string;
  code?: string;
  name?: string;
  image_url?: string;
  decimals?: number;
  denom?: number;
  fetched_at: number;
}

type Cache = Record<string, DexieCat>;

async function loadCache(): Promise<Cache> {
  const data = await chrome.storage.local.get(CACHE_KEY);
  return (data[CACHE_KEY] as Cache | undefined) ?? {};
}

async function saveCache(cache: Cache): Promise<void> {
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

function normalizeAssetId(id: string): string {
  return id.toLowerCase().replace(/^0x/, "");
}

function denomToDecimals(denom: number | undefined): number {
  if (!denom || denom <= 0) return 3;
  // denom = 1000 → 3 decimals, 1000000 → 6, etc.
  return Math.round(Math.log10(denom));
}

/**
 * Resolve metadata for a batch of asset_ids. Single HTTP request batches
 * all uncached ids via repeated `ids` query params. Missing assets fall
 * back to a synthesized record with the icon URL but no code/name.
 */
export async function resolveCatMetadata(
  assetIds: string[],
): Promise<Record<string, DexieCat>> {
  if (assetIds.length === 0) return {};
  const cache = await loadCache();
  const now = Date.now();
  const result: Record<string, DexieCat> = {};
  const toFetch: string[] = [];

  for (const id of assetIds) {
    const key = normalizeAssetId(id);
    const cached = cache[key];
    if (cached && now - cached.fetched_at < CACHE_TTL_MS) {
      result[id] = cached;
      result[key] = cached;
      result[`0x${key}`] = cached;
    } else {
      toFetch.push(key);
    }
  }

  if (toFetch.length > 0) {
    try {
      // Build the URL with one `ids=<id>` per asset.
      const params = new URLSearchParams();
      for (const id of toFetch) params.append("ids", id);
      params.set("page_size", String(toFetch.length));
      const res = await fetch(
        `https://api.dexie.space/v1/cats?${params.toString()}`,
      );
      if (res.ok) {
        const body = (await res.json()) as {
          success?: boolean;
          cats?: Array<{
            id: string;
            code?: string;
            name?: string;
            denom?: number;
          }>;
        };
        if (body?.success && Array.isArray(body.cats)) {
          for (const c of body.cats) {
            const key = normalizeAssetId(c.id);
            const decimals = denomToDecimals(c.denom);
            const meta: DexieCat = {
              asset_id: key,
              code: c.code,
              name: c.name,
              image_url: `https://icons.dexie.space/${key}.webp`,
              decimals,
              denom: c.denom,
              fetched_at: now,
            };
            cache[key] = meta;
            result[key] = meta;
            result[`0x${key}`] = meta;
          }
        }
      }
      // Synthesize entries for ids Dexie didn't recognise so we cache the
      // miss and don't refetch every tick.
      for (const id of toFetch) {
        if (!result[id]) {
          const meta: DexieCat = {
            asset_id: id,
            image_url: `https://icons.dexie.space/${id}.webp`,
            decimals: 3,
            fetched_at: now,
          };
          cache[id] = meta;
          result[id] = meta;
          result[`0x${id}`] = meta;
        }
      }
      await saveCache(cache);
    } catch {
      // best-effort — leave what we have in result and try again next tick
    }
  }

  return result;
}

// ─── XCH price (USD) — CoinGecko ───────────────────────────────────────
//
// Cached in chrome.storage.session (resets on browser close) with a short
// TTL (1 minute) so the UI feels fresh without spamming the API.

const PRICE_KEY = "xch.price.usd";
const PRICE_TTL_MS = 60_000;

export interface XchPrice {
  usd: number;
  fetched_at: number;
}

export async function getXchPriceUsd(): Promise<number | null> {
  const data = await chrome.storage.session.get(PRICE_KEY);
  const cached = data[PRICE_KEY] as XchPrice | undefined;
  if (cached && Date.now() - cached.fetched_at < PRICE_TTL_MS) {
    return cached.usd;
  }
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=chia&vs_currencies=usd",
    );
    if (!res.ok) return cached?.usd ?? null;
    const body = (await res.json()) as { chia?: { usd?: number } };
    const usd = body?.chia?.usd;
    if (typeof usd === "number" && usd > 0) {
      await chrome.storage.session.set({
        [PRICE_KEY]: { usd, fetched_at: Date.now() } satisfies XchPrice,
      });
      return usd;
    }
    return cached?.usd ?? null;
  } catch {
    return cached?.usd ?? null;
  }
}
