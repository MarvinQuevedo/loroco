import { Navigate, Route, Routes } from "react-router-dom";
import { useProvider } from "./provider/useProvider";
import { AppShell } from "./components/layout/AppShell";
import { ConnectGate } from "./components/layout/ConnectGate";
import { InstallGate } from "./components/layout/InstallGate";
import { Spinner } from "./components/ui";
import Dashboard from "./features/dashboard/Dashboard";
import Send from "./features/send/Send";
import Batch from "./features/batch/Batch";
import Tokens from "./features/tokens/Tokens";
import Nfts from "./features/nfts/Nfts";
import Offers from "./features/offers/Offers";
import Dids from "./features/dids/Dids";
import Coins from "./features/coins/Coins";
import Activity from "./features/activity/Activity";
import Signing from "./features/signing/Signing";
import Advanced from "./features/advanced/Advanced";

export function App() {
  const { status, connected } = useProvider();

  if (status === "detecting") {
    return (
      <div className="screen">
        <Spinner label="Detecting Loroco…" />
      </div>
    );
  }
  if (status === "absent") return <InstallGate />;
  if (!connected) return <ConnectGate />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/send" element={<Send />} />
        <Route path="/batch" element={<Batch />} />
        <Route path="/tokens" element={<Tokens />} />
        <Route path="/nfts" element={<Nfts />} />
        <Route path="/offers" element={<Offers />} />
        <Route path="/dids" element={<Dids />} />
        <Route path="/coins" element={<Coins />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/signing" element={<Signing />} />
        <Route path="/advanced" element={<Advanced />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
