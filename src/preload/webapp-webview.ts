import { contextBridge, ipcRenderer } from "electron";
import type { WebappPdfExportInput, WebappPdfExportResult } from "../shared/contracts";

contextBridge.exposeInMainWorld("desktopWebapp", Object.freeze({
  exportPdf: (input: WebappPdfExportInput = {}): Promise<WebappPdfExportResult> =>
    ipcRenderer.invoke("webs.webapps.exportPdf", input)
}));
