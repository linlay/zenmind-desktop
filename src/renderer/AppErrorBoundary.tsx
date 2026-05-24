import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  resetKey: string;
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    window.electronAPI.diagnostics?.reportRendererError({
      source: "react-error-boundary",
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack
    });
  }

  componentDidUpdate(previousProps: AppErrorBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private reloadWindow = () => {
    window.location.reload();
  };

  private openControlCenter = () => {
    window.location.hash = "#/control-center";
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="app-error-screen">
        <div className="app-error-panel">
          <h1>页面遇到错误</h1>
          <p>Desktop 已捕获这次异常，日志会写到主进程控制台。你可以重新加载，或先进入控制中心处理服务状态。</p>
          <div className="app-error-detail">{this.state.error.message}</div>
          <div className="app-error-actions">
            <button type="button" className="action-button" onClick={this.reloadWindow}>
              重新加载
            </button>
            <button type="button" className="text-button" onClick={this.openControlCenter}>
              进入控制中心
            </button>
          </div>
        </div>
      </div>
    );
  }
}
