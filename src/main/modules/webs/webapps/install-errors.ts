export type WebappInstallStage =
  | "archive"
  | "manifest"
  | "package"
  | "runtime"
  | "startup"
  | "install";

export class WebappInstallError extends Error {
  constructor(
    readonly stage: WebappInstallStage,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "WebappInstallError";
  }
}

export class WebappInstallPolicyError extends WebappInstallError {
  constructor(
    code: "invalid_id" | "version_content_conflict" | "downgrade_not_allowed",
    message: string,
    details: Record<string, unknown>
  ) {
    super("install", code, message, details);
    this.name = "WebappInstallPolicyError";
  }
}

export class WebappRuntimeRequiredError extends WebappInstallError {
  constructor(
    readonly webappId: string,
    readonly executable: string,
    message: string
  ) {
    super("runtime", "runtime_required", message, { webappId, runtime: executable });
    this.name = "WebappRuntimeRequiredError";
  }
}
