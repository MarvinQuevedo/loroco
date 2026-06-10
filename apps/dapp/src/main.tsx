import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App";
import { ProviderProvider } from "./provider/ProviderContext";
import { PendingTxProvider } from "./provider/PendingTxContext";
import { ToastProvider } from "./components/ui";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <HashRouter>
      <ProviderProvider>
        <ToastProvider>
          <PendingTxProvider>
            <App />
          </PendingTxProvider>
        </ToastProvider>
      </ProviderProvider>
    </HashRouter>
  </StrictMode>,
);
