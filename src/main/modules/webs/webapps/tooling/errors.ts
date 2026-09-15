export type WebappToolingStage = "arguments" | "manifest" | "package" | "archive" | "internal";

export type WebappToolingErrorDetails = Record<string, unknown>;

export type SerializedWebappToolingError = {
  stage: WebappToolingStage;
  code: string;
  message: string;
  details: WebappToolingErrorDetails;
};

export class WebappToolingError extends Error {
  readonly stage: WebappToolingStage;
  readonly code: string;
  readonly details: WebappToolingErrorDetails;

  constructor(
    stage: WebappToolingStage,
    code: string,
    message: string,
    details: WebappToolingErrorDetails = {},
  ) {
    super(message);
    this.name = "WebappToolingError";
    this.stage = stage;
    this.code = code;
    this.details = details;
  }
}

export function serializeWebappToolingError(error: unknown): SerializedWebappToolingError {
  if (error instanceof WebappToolingError) {
    return {
      stage: error.stage,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  return {
    stage: "internal",
    code: "tooling_failed",
    message: error instanceof Error ? `Desktop WebApp Tooling failed: ${error.message}` : "Desktop WebApp Tooling failed with a non-Error exception.",
    details: {
      executionState: "unknown",
      cause: error instanceof Error ? {
        name: error.name,
        message: error.message,
        ...(typeof (error as NodeJS.ErrnoException).code === "string" ? { code: (error as NodeJS.ErrnoException).code } : {}),
      } : { message: "Non-Error exception" },
      recovery: { strategy: "inspect", message: "Inspect the original failure and existing output before retrying the operation." },
    },
  };
}

export function deserializeWebappToolingError(error: SerializedWebappToolingError) {
  return new WebappToolingError(error.stage, error.code, error.message, error.details);
}
