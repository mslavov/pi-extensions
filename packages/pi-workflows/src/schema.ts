import { Compile } from "typebox/compile";
import { Type, type TSchema } from "typebox";
import { isNode, LineCounter, parseDocument, type Document, type Node } from "yaml";
import type {
  InputDefinition,
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowStep,
} from "./types.js";

const strict = { additionalProperties: false } as const;
const identifier = Type.String({ minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" });
const positiveInteger = Type.Integer({ minimum: 1 });
const value = Type.Unknown();
const valueRecord = Type.Record(Type.String({ minLength: 1 }), value);
const stringRecord = Type.Record(Type.String({ minLength: 1 }), Type.String());

const inputFields = {
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
};

export const StringInputSchema = Type.Object({
  type: Type.Literal("string"),
  ...inputFields,
  default: Type.Optional(Type.String()),
}, strict);
export const NumberInputSchema = Type.Object({
  type: Type.Literal("number"),
  ...inputFields,
  default: Type.Optional(Type.Number()),
}, strict);
export const BooleanInputSchema = Type.Object({
  type: Type.Literal("boolean"),
  ...inputFields,
  default: Type.Optional(Type.Boolean()),
}, strict);
export const JsonInputSchema = Type.Object({
  type: Type.Literal("json"),
  ...inputFields,
  default: Type.Optional(value),
}, strict);
export const InputSchema = Type.Union([
  StringInputSchema,
  NumberInputSchema,
  BooleanInputSchema,
  JsonInputSchema,
]);

export const RetrySchema = Type.Object({
  maxAttempts: positiveInteger,
  delayMs: Type.Optional(positiveInteger),
}, strict);

const condition = Type.Union([Type.Boolean(), Type.String({ minLength: 1 })]);
const base = { id: identifier, if: Type.Optional(condition) };
const timed = { ...base, timeoutMs: Type.Optional(positiveInteger) };
const continuing = { ...timed, continueOnError: Type.Optional(Type.Boolean()) };
const process = {
  ...continuing,
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  env: Type.Optional(stringRecord),
  idempotent: Type.Optional(Type.Boolean()),
  retry: Type.Optional(RetrySchema),
};

export const AgentStepSchema = Type.Object({
  ...continuing,
  type: Type.Literal("agent"),
  prompt: Type.String(),
}, strict);
export const RunStepSchema = Type.Object({
  ...process,
  type: Type.Literal("run"),
  command: Type.String({ minLength: 1 }),
  args: Type.Optional(Type.Array(Type.String())),
}, strict);
export const ShellStepSchema = Type.Object({
  ...process,
  type: Type.Literal("shell"),
  command: Type.String({ minLength: 1 }),
}, strict);
export const ScriptStepSchema = Type.Object({
  ...process,
  type: Type.Literal("script"),
  interpreter: Type.String({ minLength: 1 }),
  file: Type.String({ minLength: 1 }),
  args: Type.Optional(Type.Array(Type.String())),
}, strict);
export const SetStepSchema = Type.Object({
  ...base,
  type: Type.Literal("set"),
  values: valueRecord,
}, strict);
export const ApprovalStepSchema = Type.Object({
  ...timed,
  type: Type.Literal("approval"),
  message: Type.String(),
}, strict);
export const NestedWorkflowStepSchema = Type.Object({
  ...continuing,
  type: Type.Literal("workflow"),
  workflow: identifier,
  inputs: Type.Optional(valueRecord),
}, strict);

export const WorkflowStepSchema = Type.Union([
  AgentStepSchema,
  RunStepSchema,
  ShellStepSchema,
  ScriptStepSchema,
  SetStepSchema,
  ApprovalStepSchema,
  NestedWorkflowStepSchema,
]);

const workflowFields = {
  version: Type.Literal(1),
  id: identifier,
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  inputs: Type.Optional(Type.Record(Type.String({ minLength: 1 }), InputSchema)),
  steps: Type.Array(WorkflowStepSchema, { minItems: 1 }),
  outputs: Type.Optional(valueRecord),
};

export const WorkflowSchema = Type.Object(workflowFields, strict);

const WorkflowEnvelopeSchema = Type.Object({
  ...workflowFields,
  inputs: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Unknown())),
  steps: Type.Array(Type.Unknown(), { minItems: 1 }),
}, strict);

const validators = {
  envelope: Compile(WorkflowEnvelopeSchema),
  inputs: {
    string: Compile(StringInputSchema),
    number: Compile(NumberInputSchema),
    boolean: Compile(BooleanInputSchema),
    json: Compile(JsonInputSchema),
  },
  steps: {
    agent: Compile(AgentStepSchema),
    run: Compile(RunStepSchema),
    shell: Compile(ShellStepSchema),
    script: Compile(ScriptStepSchema),
    set: Compile(SetStepSchema),
    approval: Compile(ApprovalStepSchema),
    workflow: Compile(NestedWorkflowStepSchema),
  },
};

export interface ParsedWorkflow {
  definition?: WorkflowDefinition;
  id?: string;
  diagnostics: WorkflowDiagnostic[];
}

export function parseWorkflowYaml(source: string, sourcePath: string): ParsedWorkflow {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  const diagnostics: WorkflowDiagnostic[] = [
    ...document.errors.map((error) => yamlDiagnostic(error.message, error.pos[0], sourcePath, lineCounter)),
    ...document.warnings.map((warning) => yamlDiagnostic(warning.message, warning.pos[0], sourcePath, lineCounter, "warning")),
  ];
  if (document.errors.length > 0 || document.contents === null) return { diagnostics };

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    diagnostics.push(atOffset(
      "yaml-value",
      error instanceof Error ? error.message : String(error),
      sourcePath,
      lineCounter,
      document.contents.range?.[0] ?? 0,
    ));
    return { diagnostics };
  }

  const id = isObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
  pushSchemaErrors(validators.envelope.Errors(raw), document, lineCounter, sourcePath, diagnostics);
  if (!isObject(raw)) return { id, diagnostics };

  if (isObject(raw.inputs)) {
    for (const [name, input] of Object.entries(raw.inputs)) {
      const inputType = isObject(input) && typeof input.type === "string" ? input.type : undefined;
      const validator = inputType && inputType in validators.inputs
        ? validators.inputs[inputType as keyof typeof validators.inputs]
        : undefined;
      if (!validator) {
        diagnostics.push(atYamlPath(
          "schema-input-type",
          `Input "${name}" must declare type string, number, boolean, or json`,
          ["inputs", name, "type"],
          sourcePath,
          document,
          lineCounter,
        ));
      } else {
        pushSchemaErrors(validator.Errors(input), document, lineCounter, sourcePath, diagnostics, ["inputs", name]);
      }
    }
  }

  if (Array.isArray(raw.steps)) {
    raw.steps.forEach((step, index) => {
      const stepType = isObject(step) && typeof step.type === "string" ? step.type : undefined;
      const validator = stepType && stepType in validators.steps
        ? validators.steps[stepType as keyof typeof validators.steps]
        : undefined;
      if (!validator) {
        diagnostics.push(atYamlPath(
          "schema-step-type",
          `Step ${index + 1} must declare one of: agent, run, shell, script, set, approval, workflow`,
          ["steps", index, "type"],
          sourcePath,
          document,
          lineCounter,
        ));
      } else {
        pushSchemaErrors(validator.Errors(step), document, lineCounter, sourcePath, diagnostics, ["steps", index]);
      }
    });
  }

  const errors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  return {
    id,
    diagnostics: dedupeDiagnostics(diagnostics),
    definition: errors ? undefined : raw as unknown as WorkflowDefinition,
  };
}

function pushSchemaErrors(
  errors: Array<{ keyword: string; instancePath: string; message: string; params: Record<string, unknown> }>,
  document: Document,
  lineCounter: LineCounter,
  sourcePath: string,
  diagnostics: WorkflowDiagnostic[],
  prefix: Array<string | number> = [],
): void {
  for (const error of errors) {
    const path = [...prefix, ...pointerPath(error.instancePath)];
    if (error.keyword === "additionalProperties") {
      const fields = Array.isArray(error.params.additionalProperties)
        ? error.params.additionalProperties.map(String)
        : [];
      for (const field of fields) {
        diagnostics.push(atYamlPath(
          "schema-unknown-field",
          `Unknown field "${field}"`,
          [...path, field],
          sourcePath,
          document,
          lineCounter,
        ));
      }
      continue;
    }
    if (error.keyword === "required") {
      const fields = Array.isArray(error.params.requiredProperties)
        ? error.params.requiredProperties.map(String)
        : [];
      diagnostics.push(atYamlPath(
        "schema-required",
        `Missing required field${fields.length === 1 ? "" : "s"}: ${fields.join(", ")}`,
        path,
        sourcePath,
        document,
        lineCounter,
      ));
      continue;
    }
    diagnostics.push(atYamlPath(
      `schema-${error.keyword}`,
      error.message,
      path,
      sourcePath,
      document,
      lineCounter,
    ));
  }
}

function atYamlPath(
  code: string,
  message: string,
  path: Array<string | number>,
  sourcePath: string,
  document: Document,
  lineCounter: LineCounter,
): WorkflowDiagnostic {
  const node = document.getIn(path, true);
  const offset = isNode(node) ? node.range?.[0] : document.contents?.range?.[0];
  return atOffset(code, message, sourcePath, lineCounter, offset ?? 0, path);
}

function yamlDiagnostic(
  message: string,
  offset: number,
  sourcePath: string,
  lineCounter: LineCounter,
  severity: "error" | "warning" = "error",
): WorkflowDiagnostic {
  return { ...atOffset("yaml-parse", message, sourcePath, lineCounter, offset), severity };
}

function atOffset(
  code: string,
  message: string,
  source: string,
  lineCounter: LineCounter,
  offset: number,
  path?: Array<string | number>,
): WorkflowDiagnostic {
  const { line, col } = lineCounter.linePos(offset);
  return {
    code,
    message,
    source,
    path: path && path.length > 0 ? path.join(".") : undefined,
    line: line || 1,
    column: col || 1,
    severity: "error",
  };
}

function pointerPath(pointer: string): Array<string | number> {
  if (!pointer) return [];
  return pointer.slice(1).split("/").map((part) => {
    const decoded = part.replaceAll("~1", "/").replaceAll("~0", "~");
    return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeDiagnostics(diagnostics: WorkflowDiagnostic[]): WorkflowDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}\0${diagnostic.path}\0${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const stepSchemas: Readonly<Record<WorkflowStep["type"], TSchema>> = {
  agent: AgentStepSchema,
  run: RunStepSchema,
  shell: ShellStepSchema,
  script: ScriptStepSchema,
  set: SetStepSchema,
  approval: ApprovalStepSchema,
  workflow: NestedWorkflowStepSchema,
};

export const inputSchemas: Readonly<Record<InputDefinition["type"], TSchema>> = {
  string: StringInputSchema,
  number: NumberInputSchema,
  boolean: BooleanInputSchema,
  json: JsonInputSchema,
};
