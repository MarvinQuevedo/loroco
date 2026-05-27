// Origin-scoped permission tracking for dApp connections.

import { Errors } from "@ozone/goby-provider/errors";
import type { ChiaMethod } from "@ozone/goby-provider/types";

interface PermissionRecord {
  origin: string;
  connectedAt: number;
  /** explicit method allowlist, or `*` for all */
  methods: string[];
}

const STORAGE_KEY = "permissions";

async function load(): Promise<Record<string, PermissionRecord>> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data[STORAGE_KEY] as Record<string, PermissionRecord>) ?? {};
}

async function save(perms: Record<string, PermissionRecord>) {
  await chrome.storage.local.set({ [STORAGE_KEY]: perms });
}

export async function isConnected(origin: string): Promise<boolean> {
  const perms = await load();
  return Boolean(perms[origin]);
}

export async function listConnections(): Promise<PermissionRecord[]> {
  const perms = await load();
  return Object.values(perms).sort((a, b) => b.connectedAt - a.connectedAt);
}

export function requireConnected(origin: string): asserts origin is string {
  // sync version that throws — checked optimistically; the async ensurePermissions
  // below does the authoritative check. We keep this so the background can short-
  // circuit unauthorized requests with a cheap throw.
  if (!origin) throw Errors.unauthorized("No origin");
}

/**
 * Methods that MUST NOT be reachable from a dApp, period. These are wallet-
 * management primitives whose only legitimate caller is the wallet's own
 * popup UI (which goes engine-direct via `from: "popup"` envelopes, not
 * through this router). A dApp asking the user to combine/split coins or
 * normalize their DIDs is almost always a phishing pattern — even with an
 * approval popup the request itself shouldn't appear.
 *
 * The check fires before any approval/permission gate so dApps get a clean
 * MethodNotFound (4004) instead of leaking that the handler exists.
 */
export const POPUP_ONLY_METHODS = new Set<ChiaMethod>([
  "combine",
  "split",
  "normalizeDids",
]);

const NO_APPROVAL_METHODS = new Set<ChiaMethod>([
  "chainId",
  "getPublicKeys",
  "filterUnlockedCoins",
  "getAssetCoins",
  "getAssetBalance",
  "accounts",
  "getNFTs",
  "getNFTInfo",
  // Loroco read-only extensions — connected dApps get them without prompt.
  "getCoins",
  "getCoinsByIds",
  "isAssetOwned",
  "getCats",
  "getAllCats",
  "getToken",
  "getDerivations",
  "getTransactions",
  "getPendingTransactions",
  "getOffers",
  "getOffer",
  "getAddress",
  // Fase 3 stubs — empty reads, no on-chain side effects.
  "getDids",
  "getNftCollections",
  "getNftCollection",
  "getMinterDidIds",
]);

const ALWAYS_APPROVAL_METHODS = new Set<ChiaMethod>([
  "connect",
  "requestAccounts",
  "walletSwitchChain",
  "walletWatchAsset",
  "signCoinSpends",
  "signMessage",
  "signMessageByAddress",
  "transfer",
  "sendTransaction",
  "createOffer",
  "takeOffer",
  "cancelOffer",
  // Oleada 2 — every multi-output write broadcasts a tx.
  "bulkSendXch",
  "bulkSendCat",
  "combine",
  "split",
  // Oleada 3 — new on-chain primitives.
  "issueCat",
  "createDid",
  "addNftUri",
  "transferDid",
  "normalizeDids",
  "multiSend",
]);

export async function ensurePermissions(origin: string, method: ChiaMethod) {
  const perms = await load();
  const record = perms[origin];

  // These two are entry points — they're authoritative on whether the
  // origin is connected, so they handle their own gating.
  if (method === "connect" || method === "requestAccounts") return;

  if (!record) throw Errors.unauthorized(`${origin} is not connected`);
  if (NO_APPROVAL_METHODS.has(method)) return;
  if (ALWAYS_APPROVAL_METHODS.has(method)) return; // approval popup is launched by the handler itself
}

export async function grantConnection(origin: string) {
  const perms = await load();
  perms[origin] = {
    origin,
    connectedAt: Date.now(),
    methods: ["*"],
  };
  await save(perms);
}

export async function revokeConnection(origin: string) {
  const perms = await load();
  delete perms[origin];
  await save(perms);
}
