import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * 全局错误边界：捕获渲染阶段的异常，展示友好错误页。
 * 避免白屏，并提供刷新重试入口。
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown): void {
    // 开发期控制台保留原始错误，便于排查
    console.error("页面渲染出错：", error);
  }

  /** 刷新页面重试 */
  handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <div className="error-fallback">
        <h1 className="page-title">页面出错了</h1>
        <p className="page-subtitle">页面渲染遇到问题，刷新即可重试。若反复出现，请反馈给我们。</p>
        <button type="button" className="btn" onClick={this.handleReload}>
          刷新页面
        </button>
      </div>
    );
  }
}
