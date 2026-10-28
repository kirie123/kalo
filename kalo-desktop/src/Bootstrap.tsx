import { lazy, Suspense, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { dataTransferStatus } from "./lib/pi-bridge";
import type { TransferStatus } from "./features/data-transfer/types";
import TitleBar from "./components/TitleBar";

const App = lazy(() => import("./App"));
const DataTransferWorkspace = lazy(() => import("./features/data-transfer/DataTransferWorkspace"));

/** Normal application effects are never mounted until the native maintenance gate is resolved. */
export default function Bootstrap() {
  const [status, setStatus] = useState<TransferStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!isTauri()) { setStatus({ maintenance: false, armed: false, recoveryError: null }); return; }
    void dataTransferStatus().then(setStatus).catch((e) => setError(String(e)));
  }, []);
  const loading = <div className="transfer-workspace"><TitleBar title="Kalo" /><p className="p-6" role={error ? "alert" : "status"}>{error || "正在检查个人资料…"}</p></div>;
  if (!status) return loading;
  return <Suspense fallback={loading}>{status.maintenance ? <DataTransferWorkspace initialStatus={status} /> : <App />}</Suspense>;
}
