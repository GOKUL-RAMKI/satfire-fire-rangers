import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { Dataset, PipelineStatus } from "../shared/types.ts";
import DataProvider from "./components/DataProvider";
import Layout from "./components/Layout";
import { api, ApiError, setUnauthorizedHandler, type User } from "./lib/api";
import AlertsPage from "./pages/AlertsPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import ArchitecturePage from "./pages/ArchitecturePage";
import CommandCenter from "./pages/CommandCenter";
import EventsPage from "./pages/EventsPage";
import FacilitiesPage from "./pages/FacilitiesPage";
import FacilityDetailPage from "./pages/FacilityDetailPage";
import IncidentPage from "./pages/IncidentPage";
import LoginPage from "./pages/LoginPage";
import MapPage from "./pages/MapPage";

type Auth =
  | { phase: "checking" }
  | { phase: "anon"; notice: string | null }
  | { phase: "authed"; user: User; dataset: Dataset; status: PipelineStatus | null; session: number };

let sessionCounter = 0;

export default function App() {
  const [auth, setAuth] = useState<Auth>({ phase: "checking" });

  const boot = useCallback(async (user: User) => {
    // Default dataset: live when the backend has a FIRMS key, otherwise the labelled sample.
    let status: PipelineStatus | null = null;
    try {
      status = await api.status();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
    }
    setAuth({ phase: "authed", user, status, dataset: status?.firmsConfigured ? "live" : "sample", session: ++sessionCounter });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth({ phase: "anon", notice: "Your session has expired. Sign in again." }));
    api
      .me()
      .then(boot)
      .catch(() => setAuth({ phase: "anon", notice: null }));
    return () => setUnauthorizedHandler(null);
  }, [boot]);

  const onLogout = useCallback(() => setAuth({ phase: "anon", notice: "Signed out." }), []);

  if (auth.phase === "checking") {
    return <div className="flex h-screen items-center justify-center bg-paper font-mono text-xs text-mute">Checking session…</div>;
  }
  if (auth.phase === "anon") {
    return <LoginPage notice={auth.notice} onLogin={(u) => void boot(u)} />;
  }

  return (
    <BrowserRouter>
      <DataProvider
        key={auth.session}
        user={auth.user}
        initialDataset={auth.dataset}
        initialStatus={auth.status}
        onLogout={onLogout}
      >
        <Layout>
          <Routes>
            <Route path="/" element={<CommandCenter />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/events/:id" element={<IncidentPage />} />
            <Route path="/facilities" element={<FacilitiesPage />} />
            <Route path="/facilities/:id" element={<FacilityDetailPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/architecture" element={<ArchitecturePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </DataProvider>
    </BrowserRouter>
  );
}
