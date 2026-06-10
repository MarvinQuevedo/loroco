import type { MethodClass } from "../../features/registry";
import { Tag } from "../ui/Tag";

const CLASS_LABEL: Record<MethodClass, string> = {
  read: "read",
  write: "approval",
  wallet: "wallet-only",
  stub: "Fase 3",
};

const CLASS_TAG: Record<MethodClass, "read" | "write" | "stub"> = {
  read: "read",
  write: "write",
  wallet: "stub",
  stub: "stub",
};

// A method name with a badge describing its gating class.
export function MethodBadge({ name, cls }: { name: string; cls: MethodClass }) {
  return (
    <li>
      <code style={{ flex: 1 }}>{name}</code>
      <Tag kind={CLASS_TAG[cls]}>{CLASS_LABEL[cls]}</Tag>
    </li>
  );
}
