import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles.css";

/**
 * 构建更新自愈：浏览器若仍持有旧版本页面，它按需加载的路由 chunk 可能已随新部署消失
 * （Cloudflare 的 SPA 回退会把这类请求返回 HTML）。这里在检测到 chunk 加载失败时
 * **自动刷新一次**拿到新版本，用户无需手动清缓存。
 *
 * 为什么不会循环：刷新前写入 sessionStorage 标记，本会话只自动刷新一次；
 * 若刷新后仍失败（例如真的断网），交由 ErrorBoundary 展示错误。
 */
const RELOAD_FLAG = "create-world:chunk-reload";

/** 判断是否为「构建产物加载失败」类错误 */
function isChunkLoadError(message: string): boolean {
  return (
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("Loading chunk") ||
    message.includes("Unexpected token '<'")
  );
}

/** 自动刷新一次以获取最新构建产物 */
function reloadOnceForFreshAssets(): void {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG) === "1") {
      return;
    }
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    // 隐私模式无法记录标记：宁可刷新一次，也不要让用户卡在「加载失败」
  }
  window.location.reload();
}

window.addEventListener("error", (event) => {
  if (isChunkLoadError(event.message ?? "")) {
    reloadOnceForFreshAssets();
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { message?: string } | undefined;
  if (isChunkLoadError(reason?.message ?? "")) {
    reloadOnceForFreshAssets();
  }
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("缺少 #root 挂载节点");
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
