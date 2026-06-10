export function Spinner({ label }: { label?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, color: "var(--muted)" }}>
      <span className="spinner" />
      {label}
    </span>
  );
}
