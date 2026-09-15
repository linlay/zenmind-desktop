import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";

export type AwcpSchemaViolation = {
  instancePath: string;
  keyword: string;
};

export type AwcpSchemaValidator = (value: unknown) => AwcpSchemaViolation[];

export class AwcpSchemaCompileError extends Error {
  constructor() {
    super("The AWCP schema cannot be compiled.");
    this.name = "AwcpSchemaCompileError";
  }
}

export function compileAwcpSchema(schema: Record<string, unknown>): AwcpSchemaValidator {
  assertNoRemoteReferences(schema);
  let compiled: ValidateFunction;
  try {
    // One compiler per invocation prevents schema IDs or compiled functions from
    // becoming a cross-request snapshot cache.
    compiled = new Ajv2020({
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      strict: false,
      useDefaults: false,
      validateFormats: false,
    }).compile(schema);
  } catch {
    throw new AwcpSchemaCompileError();
  }
  return (value: unknown) => {
    if (compiled(value)) return [];
    return sanitizeViolations(compiled.errors);
  };
}

function assertNoRemoteReferences(root: unknown) {
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if ((key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") &&
          (typeof child !== "string" || !child.startsWith("#"))) {
        throw new AwcpSchemaCompileError();
      }
      pending.push(child);
    }
  }
}

function sanitizeViolations(errors: ErrorObject[] | null | undefined): AwcpSchemaViolation[] {
  return (errors ?? []).slice(0, 16).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
  }));
}
