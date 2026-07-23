import type {
  CompiledReference,
  InputDefinition,
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowStep,
} from "../types.js";

type ValueKind = CompiledReference["valueKind"];

interface StepReferenceShape {
  type: WorkflowStep["type"];
  outputKeys: ReadonlySet<string>;
  outputKind: "object" | "none" | "unknown";
}

export interface ReferenceContext {
  inputs: ReadonlyMap<string, InputDefinition["type"]>;
  vars: ReadonlyMap<string, ValueKind>;
  steps: ReadonlyMap<string, StepReferenceShape>;
}

export interface ReferenceAnalysis {
  references: CompiledReference[];
  diagnostics: WorkflowDiagnostic[];
}

const expressionPattern = /\$\{\{\s*([^{}]+?)\s*\}\}/g;
const exactPattern = /^\$\{\{\s*([^{}]+?)\s*\}\}$/;
const pathPattern = /^(inputs|vars|steps)(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;

const stepOutputs: Record<Exclude<WorkflowStep["type"], "workflow">, StepReferenceShape> = {
  agent: shape("agent", ["text"]),
  run: shape("run", ["stdout", "stderr", "exitCode", "killed", "stdoutTruncated", "stderrTruncated"]),
  shell: shape("shell", ["stdout", "stderr", "exitCode", "killed", "stdoutTruncated", "stderrTruncated"]),
  script: shape("script", ["stdout", "stderr", "exitCode", "killed", "stdoutTruncated", "stderrTruncated"]),
  set: { type: "set", outputKeys: new Set(), outputKind: "none" },
  approval: shape("approval", ["decision", "approved"]),
};

export function stepReferenceShape(
  step: WorkflowStep,
  definitions: ReadonlyMap<string, WorkflowDefinition>,
): StepReferenceShape {
  if (step.type !== "workflow") return stepOutputs[step.type];
  const outputs = definitions.get(step.workflow)?.outputs;
  return {
    type: "workflow",
    outputKeys: new Set(Object.keys(outputs ?? {})),
    outputKind: outputs ? "object" : "none",
  };
}

export function analyzeTemplate(
  value: string,
  context: ReferenceContext,
  source: string,
  path: string,
  options: { condition?: boolean } = {},
): ReferenceAnalysis {
  const diagnostics: WorkflowDiagnostic[] = [];
  const references: CompiledReference[] = [];
  const exactMatch = value.match(exactPattern);
  let matches: Array<{ 0: string; 1: string }> = [...value.matchAll(expressionPattern)]
    .map((match) => ({ 0: match[0], 1: match[1] }));

  if (options.condition && exactMatch) {
    const conditionExpression = exactMatch[1].trim();
    const expression = conditionExpression.startsWith("!")
      ? conditionExpression.slice(1).trim()
      : conditionExpression;
    matches = [{ 0: exactMatch[0], 1: expression }];
  } else if (options.condition && !exactMatch) {
    diagnostics.push(diagnostic(
      "reference-condition",
      "A string condition must be one exact reference, optionally prefixed with !",
      source,
      path,
    ));
    return { references, diagnostics };
  }

  if ((value.includes("${{") || value.includes("}}")) && matches.length === 0) {
    diagnostics.push(diagnostic("reference-syntax", "Malformed workflow reference", source, path));
    return { references, diagnostics };
  }

  const consumed = matches.reduce((total, match) => total + match[0].length, 0);
  const exact = exactMatch !== null && exactMatch[0].length === value.length;
  for (const match of matches) {
    const expression = String(match[1]).trim();
    const resolved = resolveReference(expression, context, source, path);
    diagnostics.push(...resolved.diagnostics);
    if (!resolved.reference) continue;
    if (!exact && resolved.reference.valueKind !== "scalar") {
      diagnostics.push(diagnostic(
        "reference-interpolation-type",
        `Interpolated reference "${expression}" is not statically scalar; use it as the entire value`,
        source,
        path,
      ));
    }
    references.push({ ...resolved.reference, exact });
  }

  if (consumed > 0) {
    const remainder = value.replace(expressionPattern, "");
    if (remainder.includes("${{") || remainder.includes("}}")) {
      diagnostics.push(diagnostic("reference-syntax", "Malformed workflow reference", source, path));
    }
  }
  return { references, diagnostics };
}

export function inferValueKind(value: unknown, context: ReferenceContext): ValueKind {
  if (typeof value === "string") {
    const exact = value.match(exactPattern);
    if (exact) return resolveReference(exact[1].trim(), context, "", "").reference?.valueKind ?? "unknown";
    return "scalar";
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return "scalar";
  return "json";
}

export function analyzeValue(
  value: unknown,
  context: ReferenceContext,
  source: string,
  path: string,
): ReferenceAnalysis {
  if (typeof value === "string") return analyzeTemplate(value, context, source, path);
  if (Array.isArray(value)) return merge(value.map((item, index) => analyzeValue(item, context, source, `${path}.${index}`)));
  if (isObject(value)) {
    return merge(Object.entries(value).map(([key, item]) => analyzeValue(item, context, source, `${path}.${key}`)));
  }
  return { references: [], diagnostics: [] };
}

function resolveReference(
  expression: string,
  context: ReferenceContext,
  source: string,
  path: string,
): { reference?: CompiledReference; diagnostics: WorkflowDiagnostic[] } {
  if (!pathPattern.test(expression)) {
    return {
      diagnostics: [diagnostic(
        "reference-expression",
        `Unsupported reference expression "${expression}"; use dot paths under inputs, vars, or steps`,
        source,
        path,
      )],
    };
  }
  const parts = expression.split(".");
  const root = parts[0];
  let valueKind: ValueKind = "unknown";
  let skippedOutput: CompiledReference["skippedOutput"] = "not-applicable";

  if (root === "inputs") {
    const inputType = context.inputs.get(parts[1]);
    if (!inputType) return missing("input", parts[1], expression, source, path);
    if (parts.length > 2) {
      if (inputType !== "json") return invalidPath(expression, source, path);
      valueKind = "unknown";
    } else {
      valueKind = inputType === "json" ? "json" : "scalar";
    }
  } else if (root === "vars") {
    const kind = context.vars.get(parts[1]);
    if (!kind) return missing("variable", parts[1], expression, source, path);
    valueKind = parts.length > 2 ? "unknown" : kind;
  } else {
    const step = context.steps.get(parts[1]);
    if (!step) {
      return {
        diagnostics: [diagnostic(
          "reference-step-order",
          `Step reference "${expression}" must target a previously declared step`,
          source,
          path,
        )],
      };
    }
    if (parts.length === 2) {
      valueKind = "json";
    } else if (parts[2] === "status" || parts[2] === "ok") {
      if (parts.length !== 3) return invalidPath(expression, source, path);
      valueKind = "scalar";
    } else if (parts[2] === "output") {
      skippedOutput = "error";
      if (step.outputKind === "none") {
        return {
          diagnostics: [diagnostic(
            "reference-step-output",
            `Step "${parts[1]}" (${step.type}) does not publish output`,
            source,
            path,
          )],
        };
      }
      if (parts.length === 3) {
        valueKind = step.outputKind === "unknown" ? "unknown" : "json";
      } else if (step.outputKind === "unknown") {
        valueKind = "unknown";
      } else if (!step.outputKeys.has(parts[3])) {
        return invalidPath(expression, source, path);
      } else {
        valueKind = parts.length === 4 ? "scalar" : "unknown";
      }
    } else {
      return invalidPath(expression, source, path);
    }
  }

  return {
    reference: {
      expression,
      exact: false,
      path: parts,
      valueKind,
      skippedOutput,
    },
    diagnostics: [],
  };
}

function shape(type: StepReferenceShape["type"], outputKeys: string[]): StepReferenceShape {
  return { type, outputKeys: new Set(outputKeys), outputKind: "object" };
}

function merge(analyses: ReferenceAnalysis[]): ReferenceAnalysis {
  return {
    references: analyses.flatMap((analysis) => analysis.references),
    diagnostics: analyses.flatMap((analysis) => analysis.diagnostics),
  };
}

function missing(
  kind: string,
  name: string,
  expression: string,
  source: string,
  path: string,
): { diagnostics: WorkflowDiagnostic[] } {
  return {
    diagnostics: [diagnostic(
      "reference-missing",
      `Reference "${expression}" uses unknown ${kind} "${name}"`,
      source,
      path,
    )],
  };
}

function invalidPath(
  expression: string,
  source: string,
  path: string,
): { diagnostics: WorkflowDiagnostic[] } {
  return {
    diagnostics: [diagnostic(
      "reference-path",
      `Reference path "${expression}" is not available`,
      source,
      path,
    )],
  };
}

function diagnostic(code: string, message: string, source: string, path: string): WorkflowDiagnostic {
  return { code, message, source, path, severity: "error" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
