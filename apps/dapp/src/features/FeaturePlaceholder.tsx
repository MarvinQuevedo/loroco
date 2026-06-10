import { PageHead } from "../components/layout/AppShell";
import { MethodBadge } from "../components/layout/MethodBadge";
import { Card } from "../components/ui";
import { FEATURES } from "./registry";
import type { FeatureMeta } from "./registry";

const FEATURES_BY_PATH: Record<string, FeatureMeta> = Object.fromEntries(
  FEATURES.map((f) => [f.path, f]),
);

// Until each feature's real UI lands (features phase), every section renders
// its coverage map. The provider layer, gates and types are already wired, so
// the per-feature build only needs to fill these in.
export function FeaturePlaceholder({ meta }: { meta: FeatureMeta }) {
  const hasWalletOnly = meta.methods.some((m) => m.cls === "wallet");
  const hasStub = meta.methods.some((m) => m.cls === "stub");
  return (
    <>
      <PageHead title={meta.title} blurb={meta.blurb} />
      <div className="note info">
        UI arrives in the features phase. The provider transport, connection
        gates and typed method map below are already in place.
      </div>
      <Card title="Methods this section covers">
        <ul className="method-list">
          {meta.methods.map((m) => (
            <MethodBadge key={m.name} name={m.name} cls={m.cls} />
          ))}
        </ul>
        {hasWalletOnly && (
          <div className="note warn">
            Wallet-only methods return <code>4004</code> to dApps — listed for
            completeness; they run from the wallet UI, not this console.
          </div>
        )}
        {hasStub && (
          <div className="note warn">
            Fase 3 methods return empty results until JS-side DID/collection
            sync lands.
          </div>
        )}
      </Card>
    </>
  );
}

/** Build a route component bound to the feature meta for `path`. */
export function makeFeature(path: string) {
  const meta = FEATURES_BY_PATH[path];
  return function Feature() {
    return <FeaturePlaceholder meta={meta} />;
  };
}
