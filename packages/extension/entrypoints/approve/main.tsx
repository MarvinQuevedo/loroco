import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApproveApp } from "./ApproveApp.js";
import "../popup/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <ApproveApp />
  </StrictMode>,
);
