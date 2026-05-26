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

const NO_APPROVAL_METHODS = new Set<ChiaMethod>([
  "chainId",
  "getPublicKeys",
  "filterUnlockedCoins",
  "getAssetCoins",
  "getAssetBalance",
  "accounts",
  "getNFTs",
  "getNFTInfo",
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
