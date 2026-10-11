import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import PageLoader from "./components/PageLoader";
import DiscoverPage from "./pages/DiscoverPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import WorldLayout from "./components/WorldLayout";

/**
 * 应用路由：布局 + 各页面。
 *
 * 性能约定（首屏体积直接影响打开速度）：
 * - 只保留「首屏必然用到」的页面为静态导入：发现页、登录、注册、世界区布局
 * - 其余页面（编辑器、地图、时间线、设置、后台…）一律按路由**懒加载**：
 *   它们各自拖着 TipTap / Leaflet / 地图编辑器等重依赖，早先全部打进首屏，
 *   导致入口 JS 接近 1MB，首次打开要多等好几秒
 * - 懒加载后的分包详见 vite.config.ts 的 manualChunks
 */
const MyWorldsPage = lazy(() => import("./pages/MyWorldsPage"));
const DraftsPage = lazy(() => import("./pages/DraftsPage"));
const NewWorldPage = lazy(() => import("./pages/NewWorldPage"));
const WorldPage = lazy(() => import("./pages/WorldPage"));
const WorldSettingsPage = lazy(() => import("./pages/WorldSettingsPage"));
const WorldCanvasPage = lazy(() => import("./pages/WorldCanvasPage"));
const WorldEntriesPage = lazy(() => import("./pages/WorldEntriesPage"));
const MapsPage = lazy(() => import("./pages/MapsPage"));
const WorldTimelinePage = lazy(() => import("./pages/WorldTimelinePage"));
const SearchPage = lazy(() => import("./pages/SearchPage"));
const EntryViewPage = lazy(() => import("./pages/EntryViewPage"));
const EntryVersionsPage = lazy(() => import("./pages/EntryVersionsPage"));
const EntryEditPage = lazy(() => import("./pages/EntryEditPage"));
const MapEditorPage = lazy(() => import("./pages/MapEditorPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));

/** 懒加载页面的占位：用统一的翻页加载动画，避免切换路由时出现空白或文字跳变 */
function PageLoading() {
  return <PageLoader variant="page" />;
}

/**
 * 应用路由：布局 + 各页面。
 * 懒加载的页面统一由 Suspense 包裹，切换时才拉取对应代码。
 */
export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoading />}>
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
              {/* 条目列表：画布之外的表格视图（新建 / 搜索 / 分类筛选 / 一键回到画布定位） */}
              <Route path="entries" element={<WorldEntriesPage />} />
              {/* 关系图已由画布取代：旧地址重定向，避免既有书签失效 */}
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
      </Suspense>
    </BrowserRouter>
  );
}
