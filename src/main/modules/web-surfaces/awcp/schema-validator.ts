import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";

export type AwcpSchemaViolation = {
  instancePath: string;
  keyword: string;
  expectedType?: string;
  actualType?: string;
};

export type AwcpSchemaValidator = (value: unknown) => AwcpSchemaViolation[];

export class AwcpSchemaCompileError extends Error {
  constructor(readonly schemaPath = "#", readonly keyword = "compile") {
    super("The AWCP schema cannot be compiled.");
    this.name = "AwcpSchemaCompileError";
  }
}

export function compileAwcpSchema(schema: Record<string, unknown>): AwcpSchemaValidator {
  assertLocalReferences(schema);
  let compiled: ValidateFunction;
  try {
    // One compiler per discovered Action keeps compiled schemas within the
    // current page binding instead of a cross-request cache.
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
    return sanitizeViolations(compiled.errors, value, schema);
  };
}

function pointerToken(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function atPointer(root: unknown, pointer: string): unknown {
  if (pointer === "#") return root;
  if (!pointer.startsWith("#/")) return undefined;
  let current = root;
  for (const token of pointer.slice(2).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current !== null && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, key)
      ? (current as Record<string, unknown>)[key] : undefined;
  }
  return current;
}

function assertLocalReferences(root: Record<string, unknown>) {
  const locations = new Set<string>();
  const references: { ref: string; path: string }[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 20 || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new AwcpSchemaCompileError(path, "schema");
    }
    locations.add(path);
    const schema = value as Record<string, unknown>;
    for (const keyword of ["$dynamicRef", "$recursiveRef"]) {
      if (keyword in schema) throw new AwcpSchemaCompileError(path + "/" + keyword, keyword);
    }
    if ("$ref" in schema) {
      if (typeof schema.$ref !== "string" || (schema.$ref !== "#" && !schema.$ref.startsWith("#/"))) {
        throw new AwcpSchemaCompileError(path + "/$ref", "$ref");
      }
      references.push({ ref: schema.$ref, path: path + "/$ref" });
    }
    for (const keyword of ["properties", "patternProperties", "$defs", "definitions"]) {
      const children = schema[keyword];
      if (children === undefined) continue;
      if (!children || typeof children !== "object" || Array.isArray(children)) {
        throw new AwcpSchemaCompileError(path + "/" + keyword, keyword);
      }
      for (const [name, child] of Object.entries(children)) visit(child, path + "/" + keyword + "/" + pointerToken(name), depth + 1);
    }
    for (const keyword of ["items", "contains", "propertyNames", "additionalProperties", "not", "if", "then", "else"]) {
      const child = schema[keyword];
      if (child === undefined || (keyword === "additionalProperties" && typeof child === "boolean")) continue;
      visit(child, path + "/" + keyword, depth + 1);
    }
    for (const keyword of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      const children = schema[keyword];
      if (children === undefined) continue;
      if (!Array.isArray(children)) throw new AwcpSchemaCompileError(path + "/" + keyword, keyword);
      children.forEach((child, index) => visit(child, path + "/" + keyword + "/" + index, depth + 1));
    }
  };
  visit(root, "#", 0);
  for (const { ref, path } of references) {
    if (!locations.has(ref) || atPointer(root, ref) === undefined) throw new AwcpSchemaCompileError(path, "$ref");
  }
}

function atInstance(root: unknown, path: string): unknown {
  return atPointer(root, "#" + path);
}

function relevantBranch(error: ErrorObject, root: unknown, schema: Record<string, unknown>): boolean {
  const match = error.schemaPath.match(/^(.*\/anyOf)\/(\d+)(?:\/|$)/);
  if (!match) return true;
  const branch = atPointer(schema, match[1] + "/" + match[2]);
  if (!branch || typeof branch !== "object" || Array.isArray(branch)) return true;
  let path = error.instancePath;
  let value: unknown = atInstance(root, path);
  while (path && (!value || typeof value !== "object" || Array.isArray(value))) {
    path = path.slice(0, path.lastIndexOf("/"));
    value = atInstance(root, path);
  }
  const actual = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const properties = (branch as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return true;
  const fields = properties as Record<string, unknown>;
  for (const name of ["join", "field", "func"]) {
    if (!(name in actual)) continue;
    const discriminator = fields[name];
    if (!discriminator || typeof discriminator !== "object" || Array.isArray(discriminator)) return false;
    const constraint = discriminator as Record<string, unknown>;
    if ("const" in constraint && constraint.const !== actual[name]) return false;
    if (Array.isArray(constraint.enum) && !constraint.enum.includes(actual[name])) return false;
  }
  return true;
}

function selectedProperties(rootSchema: Record<string, unknown>, actual: Record<string, unknown>): Record<string, unknown> | undefined {
  const selected = (candidate: unknown): Record<string, unknown> | undefined => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const schema = candidate as Record<string, unknown>;
    const properties = schema.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      const fields = properties as Record<string, unknown>;
      const identity = "field" in actual ? "field" : "join" in actual || "nodes" in actual ? "join" : "";
      if (identity && identity in fields && (identity !== "field" || "field" in actual) &&
          (!("func" in actual) || "func" in fields)) {
        let matches = true;
        for (const name of ["field", "func", "oper", "join"]) {
          if (!(name in actual) || !(name in fields)) continue;
          const constraint = fields[name] as Record<string, unknown>;
          if ("const" in constraint && constraint.const !== actual[name]) matches = false;
          if (Array.isArray(constraint.enum) && !constraint.enum.includes(actual[name])) matches = false;
        }
        if (matches && (identity !== "join" || "nodes" in fields)) return fields;
      }
    }
    for (const name of ["anyOf", "oneOf"]) {
      const branches = schema[name];
      if (Array.isArray(branches)) for (const child of branches) {
        const match = selected(child); if (match) return match;
      }
    }
    for (const name of ["$defs", "definitions", "properties"]) {
      const children = schema[name];
      if (children && typeof children === "object" && !Array.isArray(children)) for (const child of Object.values(children)) {
        const match = selected(child); if (match) return match;
      }
    }
    return undefined;
  };
  return selected(rootSchema);
}

function matchesSelectedFields(error: ErrorObject, root: unknown, schema: Record<string, unknown>): boolean {
  let path = error.instancePath;
  let value: unknown = atInstance(root, path);
  while (path && (!value || typeof value !== "object" || Array.isArray(value))) {
    path = path.slice(0, path.lastIndexOf("/"));
    value = atInstance(root, path);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const actual = value as Record<string, unknown>;
  const properties = selectedProperties(schema, actual);
  if (!properties) return true;
  if (error.keyword === "required") {
    return typeof error.params.missingProperty === "string" && error.params.missingProperty in properties;
  }
  if (error.keyword === "additionalProperties") {
    return typeof error.params.additionalProperty === "string" && !(error.params.additionalProperty in properties);
  }
  if (!error.instancePath.startsWith(path + "/")) return true;
  const property = error.instancePath.slice(path.length + 1).split("/")[0].replace(/~1/g, "/").replace(/~0/g, "~");
  if (!(property in properties)) return false;
  if (error.keyword === "enum" || error.keyword === "const") {
    const constraint = properties[property] as Record<string, unknown>;
    const input = actual[property];
    if ("const" in constraint && constraint.const === input) return false;
    if (Array.isArray(constraint.enum) && constraint.enum.includes(input)) return false;
  }
  return true;
}

function sanitizeViolations(errors: ErrorObject[] | null | undefined, root: unknown, schema: Record<string, unknown>): AwcpSchemaViolation[] {
  const all = errors ?? [];
  const related = all.filter((error) => error.keyword !== "anyOf" && relevantBranch(error, root, schema) && matchesSelectedFields(error, root, schema));
  const discriminatorErrors = all.filter((error) => (error.keyword === "enum" || error.keyword === "const") &&
    /\/(field|func|join|oper)$/.test(error.instancePath));
  let mismatch: ErrorObject | undefined;
  for (const name of ["field", "join", "func", "oper"]) {
    const candidate = discriminatorErrors.find((error) => error.instancePath.endsWith("/" + name));
    if (!candidate) continue;
    const parent = candidate.instancePath.slice(0, candidate.instancePath.lastIndexOf("/"));
    const actual = atInstance(root, parent);
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) continue;
    const input = actual as Record<string, unknown>;
    const sample: Record<string, unknown> = {};
    if ("field" in input) sample.field = input.field;
    if ("join" in input) sample.join = input.join;
    if (name === "func" || name === "oper") {
      if ("func" in input) sample.func = input.func;
    }
    if (name === "oper" && "oper" in input) sample.oper = input.oper;
    if (!selectedProperties(schema, sample)) { mismatch = candidate; break; }
  }
  const fallback = discriminatorErrors.length > 0 ? discriminatorErrors : all.filter((error) => error.keyword !== "anyOf");
  const chosen = mismatch ? [mismatch] : related.length > 0 ? related : fallback;
  const seen = new Set<string>();
  return chosen.filter((error) => {
    const identity = `${error.instancePath}\0${error.keyword}\0${JSON.stringify(error.params)}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(0, 16).map((error) => {
    const violation: AwcpSchemaViolation = { instancePath: error.instancePath, keyword: error.keyword };
    if (error.keyword === "type" && typeof error.params.type === "string") {
      violation.expectedType = error.params.type;
      const value = atInstance(root, error.instancePath);
      // Report types only: never echo the rejected business value.
      violation.actualType = value === undefined ? "missing" : value === null ? "null"
        : Array.isArray(value) ? "array" : typeof value;
    }
    return violation;
  });
}
