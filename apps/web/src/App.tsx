import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import WorldLayout from "./components/WorldLayout";
import AdminPage from "./pages/AdminPage";
import DiscoverPage from "./pages/DiscoverPage";
import DraftsPage from "./pages/DraftsPage";
import EntryEditPage from "./pages/EntryEditPage";
import EntryVersionsPage from "./pages/EntryVersionsPage";
import EntryViewPage from "./pages/EntryViewPage";
import LoginPage from "./pages/LoginPage";
import MapEditorPage from "./pages/MapEditorPage";
import MapsPage from "./pages/MapsPage";
import MyWorldsPage from "./pages/MyWorldsPage";
import NewWorldPage from "./pages/NewWorldPage";
import NotFoundPage from "./pages/NotFoundPage";
import RegisterPage from "./pages/RegisterPage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import WorldCanvasPage from "./pages/WorldCanvasPage";
import WorldPage from "./pages/WorldPage";
import WorldSettingsPage from "./pages/WorldSettingsPage";
import WorldTimelinePage from "./pages/WorldTimelinePage";

/**
 * 应用路由：布局 + 各页面。
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<DiscoverPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="register" element={<RegisterPage />} />
          <Route path="worlds" element={<MyWorldsPage />} />
          <Route path="drafts" element={<DraftsPage />} />
          <Route path="worlds/new" element={<NewWorldPage />} />
          <Route path="w/:worldId" element={<WorldLayout />}>
            <Route index element={<WorldPage />} />
            <Route path="settings" element={<WorldSettingsPage />} />
            <Route path="canvas" element={<WorldCanvasPage />} />
            <Route path="maps" element={<MapsPage />} />
            <Route path="timeline" element={<WorldTimelinePage />} />
            <Route path="search" element={<SearchPage />} />
            {/* 条目列表与关系图已由画布取代：旧地址重定向到画布，避免既有书签失效 */}
            <Route path="entries" element={<Navigate to="../canvas" replace />} />
            <Route path="graph" element={<Navigate to="../canvas" replace />} />
            <Route path="entries/:entryId" element={<EntryViewPage />} />
            <Route path="entries/:entryId/versions" element={<EntryVersionsPage />} />
          </Route>
          {/* 条目编辑页独立全宽（写作专注，不套世界侧边栏） */}
          <Route path="w/:worldId/entries/:entryId/edit" element={<EntryEditPage />} />
          {/* 地图编辑器同样独立全宽：它是全屏工作区（方案 §12.4） */}
          <Route path="maps/:mapId/edit" element={<MapEditorPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
