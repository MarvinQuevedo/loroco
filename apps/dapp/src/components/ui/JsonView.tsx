// Collapsible raw-JSON inspector. BigInt-safe (mojo amounts).

export function JsonView({ value, label = "Raw result" }: { value: unknown; label?: string }) {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  } catch {
    text = String(value);
  }
  return (
    <details className="json-view">
      <summary>{label}</summary>
      <pre>{text}</pre>
    </details>
  );
}
