import { parentPort, workerData } from "node:worker_threads";
import type { AssistantAttachmentTaskProgress } from "../../shared/contracts";
import { createAssistantAttachmentsFromFilesInProcess } from "./attachment-store";

type AttachmentWorkerData = {
  userDataPath: string;
  chatId?: string | null;
  filePaths: string[];
  taskId: string;
};

const data = workerData as AttachmentWorkerData;

function postProgress(progress: AssistantAttachmentTaskProgress) {
  parentPort?.postMessage({
    type: "progress",
    progress
  });
}

async function run() {
  try {
    const app = {
      getPath(name: string) {
        if (name !== "userData") {
          throw new Error(`附件 worker 不支持读取 ${name} 路径。`);
        }
        return data.userDataPath;
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
