import { parentPort, workerData } from "node:worker_threads";
import type { AssistantAttachmentTaskProgress } from "../../../../shared/contracts";
import { setMainLocaleForCurrentProcess } from "../../../support/i18n/main-i18n";
import { createAssistantAttachmentsFromFilesInProcess } from "./attachment-store";

type AttachmentWorkerData = {
  assistantTempRoot: string;
  chatId?: string | null;
  filePaths: string[];
  taskId: string;
  locale?: string;
};

const data = workerData as AttachmentWorkerData;
setMainLocaleForCurrentProcess(data.locale);

function postProgress(progress: AssistantAttachmentTaskProgress) {
  parentPort?.postMessage({
    type: "progress",
    progress
  });
}

async function run() {
  try {
    const app = {
      assistantTempRoot: data.assistantTempRoot,
      getPath(name: string) {
        if (name !== "temp") {
          throw new Error(`attachment worker cannot read ${name} paths.`);
        }
        return data.assistantTempRoot;
      }
    };
    const result = await createAssistantAttachmentsFromFilesInProcess(app, data.chatId, data.filePaths, {
      taskId: data.taskId,
      useWorker: false,
      onProgress: postProgress
    });
    parentPort?.postMessage({
      type: "result",
      result
    });
  } catch (error) {
    parentPort?.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

void run();
