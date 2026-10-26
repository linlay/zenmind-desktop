/** Non-routing regression fixtures explicitly select their declared browser for each new Run. */
export async function registerBrowserTask(runtime, source, browser = runtime.state(source.chatId).backend) {
  runtime.registerRun(source);
  await runtime.cdp({ method: "Browser.select", params: { browser }, source }, undefined,
    async () => { throw new Error("Task browser selection must be handled by Main."); });
}
