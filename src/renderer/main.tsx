import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App";
import { STORAGE_NAMESPACE } from "../shared/generated/brand";
import "./styles.css";

try {
  const savedTheme = window.localStorage.getItem(`${STORAGE_NAMESPACE}.theme`);
  document.documentElement.dataset.theme = savedTheme === "dark" ? "dark" : "light";
} catch {
  document.documentElement.dataset.theme = "light";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
