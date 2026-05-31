// Origin-scoped permission tracking for dApp connections.
//
// Two invariants live here on top of the bare "is this origin connected?"
// check:
//
//   • Per-connection SCOPE (#2). A connection is granted either `full`
//     (every method, signing included — still per-call approved) or
//     `read-only` (read methods only; any signing/mutating method is
//     rejected OUTRIGHT, before the approval popup ever appears). This is
//     the "this dApp may never request signing" mode — the user picks it
//     at connect time and a read-only origin literally cannot reach a
//     signing handler even with a forged request.
//
//   • Sliding-window EXPIRY (#4). A connection expires CONNECTION_TTL_MS
//     after its last authorized use. Every authorized call slides the
//     window forward (throttled so read-polling dApps don't thrash
//     storage), so an actively-used dApp never expires while an abandoned
//     one is auto-revoked. Expiry is enforced lazily on access and swept
//     periodically by the background alarm.

import { Errors } from "@ozone/goby-provider/errors";
import type { ChiaMethod } from "@ozone/goby-provider/types";

/** A connection is either full-access or read-only. */
export type ConnectionScope = "full" | "read-only";

export interface PermissionRecord {
  origin: string;
  connectedAt: number;
  /** Last time an authorized call was made on this connection. */
  lastUsedAt: number;
  /** Sliding deadline — connection is dead once `Date.now() > expiresAt`. */
  expiresAt: number;
  /** `full` → signing allowed (per-call approved); `read-only` → reads only. */
  scope: ConnectionScope;
  /** explicit method allowlist, or `*` for all. Kept for UI + back-compat. */
  methods: string[];
}

const STORAGE_KEY = "permissions";

/**
 * Sliding-window TTL: a connection dies this long after its last authorized
 * use. The user picked 7 days — long enough that a daily-driver dApp never
 * re-prompts, short enough that a site connected once and abandoned drops
 * off within a week.
 */
export const CONNECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * We only persist a slid expiry at most this often per origin. A read-heavy
 * dApp polling getAssetBalance every few seconds would otherwise issue a
 * chrome.storage.local write per call; throttling to hourly keeps the
 * window fresh without the write amplification.
 */
const SLIDE_THROTTLE_MS = 60 * 60 * 1000;

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
  "bulkMintNfts",
]);

/**
 * The signing/mutating surface a `read-only` connection is forbidden from
 * reaching. It's every approval-gated method EXCEPT the two connection
 * entry points (which are how a read-only grant is created in the first
 * place and which never sign). A read-only origin calling any of these is
 * rejected with 4001 before the approval popup is ever scheduled.
 */
const SIGNING_MUTATING_METHODS = new Set<ChiaMethod>(
  [...ALWAYS_APPROVAL_METHODS].filter(
    (m) => m !== "connect" && m !== "requestAccounts",
  ),
);

/**
 * Normalise a stored record to the current shape. Records written before
 * scope/expiry existed lack those fields; we treat a missing scope as
 * `full` (that was the only mode) and synthesise a sliding deadline from
 * the last-used (or connected) timestamp so legacy grants also age out
 * instead of living forever.
 */
function normalize(raw: Partial<PermissionRecord> & { origin: string }): PermissionRecord {
  const connectedAt = typeof raw.connectedAt === "number" ? raw.connectedAt : Date.now();
  const lastUsedAt = typeof raw.lastUsedAt === "number" ? raw.lastUsedAt : connectedAt;
  const expiresAt =
    typeof raw.expiresAt === "number" ? raw.expiresAt : lastUsedAt + CONNECTION_TTL_MS;
  const scope: ConnectionScope = raw.scope === "read-only" ? "read-only" : "full";
  const methods = Array.isArray(raw.methods)
    ? raw.methods
    : scope === "full"
      ? ["*"]
      : [];
  return { origin: raw.origin, connectedAt, lastUsedAt, expiresAt, scope, methods };
}

async function load(): Promise<Record<string, PermissionRecord>> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const raw = (data[STORAGE_KEY] as Record<string, Partial<PermissionRecord>> | undefined) ?? {};
  const out: Record<string, PermissionRecord> = {};
  for (const [origin, rec] of Object.entries(raw)) {
    out[origin] = normalize({ ...rec, origin });
  }
  return out;
}

async function save(perms: Record<string, PermissionRecord>) {
  await chrome.storage.local.set({ [STORAGE_KEY]: perms });
}

function isExpired(record: PermissionRecord, now: number): boolean {
  return record.expiresAt < now;
}

export async function isConnected(origin: string): Promise<boolean> {
  const perms = await load();
  const record = perms[origin];
  if (!record) return false;
  if (isExpired(record, Date.now())) {
    delete perms[origin];
    await save(perms);
    return false;
  }
  return true;
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

export async function ensurePermissions(origin: string, method: ChiaMethod) {
  // These two are entry points — they're authoritative on whether the
  // origin is connected, so they handle their own gating (and creating the
  // grant). Nothing to check or slide here.
  if (method === "connect" || method === "requestAccounts") return;

  const perms = await load();
  const record = perms[origin];
  if (!record) throw Errors.unauthorized(`${origin} is not connected`);

  // #4 — sliding expiry. An expired connection is treated as fully revoked:
  // purge it and reject so the dApp must reconnect (re-prompting the user).
  const now = Date.now();
  if (isExpired(record, now)) {
    delete perms[origin];
    await save(perms);
    throw Errors.unauthorized(
      `${origin} connection expired after inactivity — reconnect to continue`,
    );
  }

  // #2 — read-only scope. A read-only connection can never reach a
  // signing/mutating method; reject BEFORE any approval popup is scheduled
  // so the user isn't even asked (and a forged request can't slip through).
  if (record.scope === "read-only" && SIGNING_MUTATING_METHODS.has(method)) {
    throw Errors.unauthorized(
      `${origin} is connected read-only; "${method}" needs a full-access connection. ` +
        `Disconnect and reconnect granting full access to use it.`,
    );
  }

  if (NO_APPROVAL_METHODS.has(method) || ALWAYS_APPROVAL_METHODS.has(method)) {
    // #4 — slide the window forward on each authorized use, throttled so a
    // polling dApp doesn't issue a storage write per call.
    if (now - record.lastUsedAt > SLIDE_THROTTLE_MS) {
      record.lastUsedAt = now;
      record.expiresAt = now + CONNECTION_TTL_MS;
      perms[origin] = record;
      await save(perms);
    }
    return;
  }
  // Unrecognised method: fall through without sliding. The handler will
  // surface MethodNotFound at dispatch.
}

/**
 * The scope a dApp REQUESTS via its connect params, normalised. This is a
 * ceiling, not the granted scope: the user may downgrade a "full" request to
 * read-only at the prompt, but a "read-only" request is locked there. Absent
 * or unrecognised → "full" (write), preserving Goby's connect-implies-write
 * default. Accepts a few friendly spellings dApps send in the wild
 * (read/readonly/read-only, write → full).
 */
export function normalizeRequestedScope(params: unknown): ConnectionScope {
  const p = params as { scope?: unknown; readOnly?: unknown } | null | undefined;
  if (p && typeof p === "object") {
    if (p.readOnly === true) return "read-only";
    const s =
      typeof p.scope === "string" ? p.scope.toLowerCase().replace(/[_\s]/g, "-") : "";
    if (s === "read-only" || s === "readonly" || s === "read") return "read-only";
  }
  return "full";
}

/**
 * Clamp the user's chosen scope to the dApp's requested ceiling. The user can
 * grant LESS than the dApp asked for (full request → read-only) but never
 * MORE — a read-only request stays read-only no matter what the popup sends
 * back. This is the authoritative privilege gate; the popup UI only mirrors
 * it cosmetically.
 */
export function clampScope(
  requested: ConnectionScope,
  chosen: ConnectionScope,
): ConnectionScope {
  return requested === "read-only" ? "read-only" : chosen;
}

export async function grantConnection(
  origin: string,
  scope: ConnectionScope = "full",
) {
  const perms = await load();
  const now = Date.now();
  perms[origin] = {
    origin,
    connectedAt: now,
    lastUsedAt: now,
    expiresAt: now + CONNECTION_TTL_MS,
    scope,
    methods: scope === "full" ? ["*"] : [],
  };
  await save(perms);
}

export async function revokeConnection(origin: string) {
  const perms = await load();
  delete perms[origin];
  await save(perms);
}

/**
 * Drop every connection whose sliding window has elapsed. Called from the
 * background alarm so idle grants are reclaimed even if the dApp never calls
 * again (lazy purge in ensurePermissions/isConnected only fires on access).
 * Returns the number of connections removed.
 */
export async function purgeExpiredConnections(): Promise<number> {
  const perms = await load();
  const now = Date.now();
  let removed = 0;
  for (const [origin, record] of Object.entries(perms)) {
    if (isExpired(record, now)) {
      delete perms[origin];
      removed += 1;
    }
  }
  if (removed > 0) await save(perms);
  return removed;
}
