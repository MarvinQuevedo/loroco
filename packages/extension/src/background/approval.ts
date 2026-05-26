// dApp approval queue.
//
// When a dApp triggers a method that needs explicit user consent
// (connect, signCoinSpends, signMessage, sendTransaction, etc.) the
// background service worker stashes the request in a pending map and:
//   1. Tries `chrome.action.openPopup()` so the extension popup pops over
//      the toolbar — same UX as MetaMask. (Chrome 127+; from SW.)
//   2. Sets a badge ("!") on the action icon so a closed popup still
//      surfaces the pending request.
//   3. The popup's App polls for pending requests on mount + via storage
//      change events and renders the inline approval screen.
//
// The decision is round-tripped via the existing `from: "approval"`
// envelope so the popup-side approval UI keeps using the same API the
// standalone `approve.html` page used.

import type { ChiaMethod } from "@ozone/goby-provider/types";

export interface PendingRequest {
  id: string;
  origin: string;
  method: ChiaMethod;
  params: unknown;
  createdAt: number;
}

export interface ApprovalDecision {
  approved: boolean;
  /**
   * Optional shallow override on the original params. Methods that care
   * (e.g. createOffer letting the user reduce dexie's default fee) merge
   * these on top of `request.params` before dispatching the engine call.
   */
  overrides?: Record<string, unknown>;
}

interface PendingEntry {
  request: PendingRequest;
  resolve: (decision: ApprovalDecision) => void;
  windowId?: number;
}

const PENDING = new Map<string, PendingEntry>();

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const PENDING_KEY = "pendingApprovals";

async function syncPendingToStorage(): Promise<void> {
  // Mirror the in-memory queue into chrome.storage.session so the popup can
  // see pending requests even when our SW state hasn't been observed yet.
  const list = [...PENDING.values()].map((e) => e.request);
  await chrome.storage.session.set({ [PENDING_KEY]: list });
}

async function updateBadge(): Promise<void> {
  const count = PENDING.size;
  if (count > 0) {
    await chrome.action.setBadgeText({ text: count > 9 ? "9+" : String(count) }).catch(() => {});
    await chrome.action
      .setBadgeBackgroundColor({ color: "#E38C1B" /* ozone-orange */ })
      .catch(() => {});
  } else {
    await chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }
}

/**
 * Request user approval.
 *
 * Resolves to a decision object so handlers that want to honour user
 * overrides (fee picker, etc.) can read them. Callers that only care
 * about the boolean check `.approved`.
 */
export function requestApproval(
  origin: string,
  method: ChiaMethod,
  params: unknown,
): Promise<ApprovalDecision> {
  const request: PendingRequest = {
    id: newId(),
    origin,
    method,
    params,
    createdAt: Date.now(),
  };

  return new Promise<ApprovalDecision>((resolve) => {
    const entry: PendingEntry = { request, resolve };
    PENDING.set(request.id, entry);
    void syncPendingToStorage();
    void updateBadge();

    // Best-effort: open the extension popup (Chrome 127+ allows this from a
    // service worker). If unavailable, the badge + onClicked handler still
    // lets the user see the pending request when they click the icon.
    try {
      void (chrome.action.openPopup?.() as Promise<void> | undefined)?.catch(() => {});
    } catch {
      // ignore — falls back to badge-only
    }
  });
}

export function getPending(id: string): PendingRequest | null {
  return PENDING.get(id)?.request ?? null;
}

export function decidePending(
  id: string,
  approved: boolean,
  overrides?: Record<string, unknown>,
): boolean {
  const entry = PENDING.get(id);
  if (!entry) return false;
  PENDING.delete(id);
  entry.resolve({ approved, ...(overrides ? { overrides } : {}) });
  void syncPendingToStorage();
  void updateBadge();
  return true;
}

/** Called when the popup wants to cancel a request without deciding. */
export function cancelPending(id: string): void {
  const entry = PENDING.get(id);
  if (!entry) return;
  PENDING.delete(id);
  entry.resolve({ approved: false });
  void syncPendingToStorage();
  void updateBadge();
}

/** Auto-reject every pending if the user explicitly locks the wallet. */
export function cancelAll(): void {
  for (const id of [...PENDING.keys()]) cancelPending(id);
}

/** List the currently-pending requests (oldest first) for the popup UI. */
export function listPending(): PendingRequest[] {
  return [...PENDING.values()].map((e) => e.request);
}

export type ApprovalMessage =
  | { from: "approval"; kind: "fetch"; id: string }
  | {
      from: "approval";
      kind: "decide";
      id: string;
      approved: boolean;
      /** Per-method param overrides — e.g. {fee: "100"} for createOffer. */
      overrides?: Record<string, unknown>;
    };

export type ApprovalResponse =
  | { ok: true; request?: PendingRequest }
  | { ok: false; error: string };

export function isApprovalMessage(msg: unknown): msg is ApprovalMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { from?: unknown }).from === "approval"
  );
}

export async function handleApprovalMessage(msg: ApprovalMessage): Promise<ApprovalResponse> {
  switch (msg.kind) {
    case "fetch": {
      const req = getPending(msg.id);
      if (!req) return { ok: false, error: "no pending request with that id" };
      return { ok: true, request: req };
    }
    case "decide": {
      const found = decidePending(msg.id, msg.approved, msg.overrides);
      if (!found) return { ok: false, error: "no pending request with that id" };
      return { ok: true };
    }
  }
}
