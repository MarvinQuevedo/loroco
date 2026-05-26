// Per-wallet derivation metadata kept in chrome.storage.local.
//
// Layout:
//   chrome.storage.local["derivations.<fingerprint>"] = {
//     activeIndex: number,
//     labels: { [index]: string },
//   }
//
// The actual addresses themselves are derived on-demand from the engine —
// we only persist user-editable metadata + the last-selected index so the
// Receive tab can resume where the user left off.

const KEY_PREFIX = "derivations.";

export interface DerivationState {
  activeIndex: number;
  labels: Record<string, string>;
}

const empty = (): DerivationState => ({ activeIndex: 0, labels: {} });

export async function getDerivationState(fingerprint: number): Promise<DerivationState> {
  const key = `${KEY_PREFIX}${fingerprint}`;
  const data = await chrome.storage.local.get(key);
  return (data[key] as DerivationState | undefined) ?? empty();
}

export async function saveDerivationState(
  fingerprint: number,
  state: DerivationState,
): Promise<void> {
  const key = `${KEY_PREFIX}${fingerprint}`;
  await chrome.storage.local.set({ [key]: state });
}

export async function setActiveIndex(fingerprint: number, index: number): Promise<void> {
  const state = await getDerivationState(fingerprint);
  state.activeIndex = index;
  await saveDerivationState(fingerprint, state);
}

export async function setLabel(
  fingerprint: number,
  index: number,
  label: string,
): Promise<void> {
  const state = await getDerivationState(fingerprint);
  if (label.trim()) {
    state.labels[String(index)] = label.trim();
  } else {
    delete state.labels[String(index)];
  }
  await saveDerivationState(fingerprint, state);
}
