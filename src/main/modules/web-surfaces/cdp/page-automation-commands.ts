import type { WebContents } from "electron";
import type { SurfaceObservationRegistry } from "./observation";
import type { WorkPanelPageAutomation } from "./page-automation";

type Send = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<any>;
export const PAGE_AUTOMATION_METHODS = new Set(["Surface.handleDialog", "Surface.uploadFiles", "Surface.getDownloads", "Surface.readDownload"]);

function invalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "invalid_params" });
}
function onlyKeys(params: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(params).some((key) => !allowed.includes(key))) throw invalid("Unknown page operation parameter.");
}
function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw invalid(`${name} must be a non-empty string of at most 200 characters.`);
  return value;
}

/** WorkPanel dialogs, uploads and downloads with the same contract as the Chrome provider. */
export async function executePageAutomationCommand(input: {
  method: string; params: Record<string, unknown>; surfaceId: string; contents: WebContents;
  automation: WorkPanelPageAutomation; observations: SurfaceObservationRegistry; send: Send;
  validate: () => Promise<void>; signal?: AbortSignal;
}): Promise<{ result: object; observe: boolean }> {
  const { method, params, surfaceId, contents, automation, observations, send } = input;
  if (method === "Surface.getDownloads") {
    onlyKeys(params, []);
    return { result: { downloads: automation.listDownloads(contents) }, observe: false };
  }
  if (method === "Surface.readDownload") {
    onlyKeys(params, ["downloadId"]);
    return { result: await automation.readDownload(contents, identifier(params.downloadId, "downloadId")), observe: false };
  }
  if (method === "Surface.handleDialog") {
    onlyKeys(params, ["observationId", "dialogId", "action", "promptText"]);
    if (params.action !== "accept" && params.action !== "dismiss") throw invalid("Choose accept or dismiss for an observed dialog.");
    if (params.promptText !== undefined && (typeof params.promptText !== "string" || params.promptText.length > 4096)) {
      throw invalid("promptText must be a string of at most 4096 characters.");
    }
    observations.assertCurrent(surfaceId, contents, params.observationId);
    const result = await automation.handleDialog(contents, identifier(params.dialogId, "dialogId"), params.action === "accept", params.promptText as string | undefined);
    return { result, observe: true };
  }
  onlyKeys(params, ["observationId", "ref", "chooserId", "files"]);
  if ((params.ref !== undefined) === (params.chooserId !== undefined)) throw invalid("Choose one observed file input or file chooser.");
  observations.assertCurrent(surfaceId, contents, params.observationId);
  const count = Array.isArray(params.files) ? params.files.length : 0;
  if (params.chooserId !== undefined) {
    const chooserId = identifier(params.chooserId, "chooserId");
    const chooser = automation.chooser(contents, chooserId);
    if (!chooser.multiple && count > 1) throw invalid("This file chooser accepts one file.");
    const files = automation.writeUploads(contents, params.files);
    try { await send("DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId }, 10_000); }
    catch (error) {
      // A synchronous onchange dialog proves the chooser dispatched; never offer it for a replay.
      if ((error as { code?: unknown })?.code === "dialog_pending") automation.completeChooser(contents, chooserId);
      throw error;
    }
    automation.completeChooser(contents, chooserId);
    return { result: { status: "uploaded", fileCount: files.length }, observe: true };
  }
  const target = await observations.fileInput(surfaceId, {
    observationId: identifier(params.observationId, "observationId"), ref: identifier(params.ref, "ref"),
  }, contents, send, input.validate, input.signal);
  if (!target.multiple && count > 1) throw invalid("This file input accepts one file.");
  // Validate and stage all bytes before the page changes.
  const files = automation.writeUploads(contents, params.files);
  await send("DOM.setFileInputFiles", { files, objectId: target.objectId }, 10_000);
  return { result: { status: "uploaded", fileCount: files.length }, observe: true };
}
