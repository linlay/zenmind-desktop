/** Non-routing regression fixtures explicitly select their declared browser for each new Run. */
export async function registerBrowserTask(runtime, source, browser = runtime.state(source.chatId).backend) {
  runtime.registerRun(source);
  await runtime.cdp({ method: "Browser.select", params: { browser }, source }, undefined,
    async () => { throw new Error("Task browser selection must be handled by Main."); });
}

/** Normal task completion waits for the real workspace cleanup; cancellation tests keep their own gates. */
export async function releaseBrowserTask(runtime, runId) {
  const run = runtime.runs.get(runId), workspace = run ? runtime.workspaces.get(run.workspaceId) : undefined;
  runtime.releaseRun(runId);
  await workspace?.drain;
}
