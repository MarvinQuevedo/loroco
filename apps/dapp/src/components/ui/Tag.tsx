import type { ReactNode } from "react";

export function Tag({ kind, children }: { kind: "read" | "write" | "stub"; children: ReactNode }) {
  return <span className={`tag tag-${kind}`}>{children}</span>;
}
