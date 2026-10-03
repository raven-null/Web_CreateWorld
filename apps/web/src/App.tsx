import { BrowserRouter, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import AdminPage from "./pages/AdminPage";
import DiscoverPage from "./pages/DiscoverPage";
import DraftsPage from "./pages/DraftsPage";
import EntryEditPage from "./pages/EntryEditPage";
import EntryVersionsPage from "./pages/EntryVersionsPage";
import EntryViewPage from "./pages/EntryViewPage";
import LoginPage from "./pages/LoginPage";
import MapsPage from "./pages/MapsPage";
import MyWorldsPage from "./pages/MyWorldsPage";
import NewWorldPage from "./pages/NewWorldPage";
import NotFoundPage from "./pages/NotFoundPage";
import RegisterPage from "./pages/RegisterPage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import WorldEntriesPage from "./pages/WorldEntriesPage";
import WorldGraphPage from "./pages/WorldGraphPage";
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
          <Route path="w/:worldId" element={<WorldPage />} />
          <Route path="w/:worldId/settings" element={<WorldSettingsPage />} />
          <Route path="w/:worldId/graph" element={<WorldGraphPage />} />
          <Route path="w/:worldId/maps" element={<MapsPage />} />
          <Route path="w/:worldId/timeline" element={<WorldTimelinePage />} />
          <Route path="w/:worldId/search" element={<SearchPage />} />
          <Route path="w/:worldId/entries" element={<WorldEntriesPage />} />
          <Route path="w/:worldId/entries/:entryId" element={<EntryViewPage />} />
          <Route path="w/:worldId/entries/:entryId/edit" element={<EntryEditPage />} />
          <Route path="w/:worldId/entries/:entryId/versions" element={<EntryVersionsPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
