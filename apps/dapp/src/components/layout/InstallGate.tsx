import { Button } from "../ui";

const STORE_URL =
  "https://chromewebstore.google.com/detail/jkpbdpldleedflbgpemgpigdhnlmaklp";
const DOCS_URL = "https://marvinquevedo.github.io/loroco/";

// Shown when no provider is injected after the detection window.
export function InstallGate() {
  return (
    <div className="screen">
      <div className="screen-card">
        <img className="screen-logo" src="/icon.png" alt="Loroco" />
        <h1>Loroco not detected</h1>
        <p style={{ color: "var(--muted)" }}>
          This console talks to the Loroco browser wallet through{" "}
          <code>window.chia</code>. Install the extension, then reload this page.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 18 }}>
          <Button onClick={() => window.open(STORE_URL, "_blank", "noopener")}>
            Install from Chrome Web Store
          </Button>
          <Button variant="ghost" onClick={() => window.open(DOCS_URL, "_blank", "noopener")}>
            Read the docs
          </Button>
        </div>
        <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 18 }}>
          Already installed? Make sure it's enabled, then{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); location.reload(); }}>
            reload
          </a>
          .
        </p>
      </div>
    </div>
  );
}
