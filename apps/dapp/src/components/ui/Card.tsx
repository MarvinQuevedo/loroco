import type { ReactNode } from "react";

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={["card", className].filter(Boolean).join(" ")}>
      {(title || actions) && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          {title && <h3 className="card-title" style={{ margin: 0, flex: 1 }}>{title}</h3>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
