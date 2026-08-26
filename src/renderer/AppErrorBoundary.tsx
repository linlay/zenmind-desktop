import { Component, type ErrorInfo, type ReactNode } from "react";
import { RendererI18nContext, type RendererI18nContextValue } from "./i18n/i18n-context";

type AppErrorBoundaryProps = {
  resetKey: string;
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  static contextType = RendererI18nContext;
  declare context: RendererI18nContextValue;

  state: AppErrorBoundaryState = {
    error: null
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    window.electronAPI.diagnostics?.reportRendererError({
      level: "error",
      source: "react-error-boundary",
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack ?? undefined
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
    const { t } = this.context;

    return (
      <div className="app-error-screen">
        <div className="app-error-panel">
          <h1>{t("appError.title")}</h1>
          <p>{t("appError.description")}</p>
          <div className="app-error-detail">{this.state.error.message}</div>
          <div className="app-error-actions">
            <button type="button" className="action-button" onClick={this.reloadWindow}>
              {t("appError.reload")}
            </button>
            <button type="button" className="text-button" onClick={this.openControlCenter}>
              {t("appError.openControlCenter")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
