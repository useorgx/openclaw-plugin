export const PRACTICE_EXERCISE_TEMPLATE_SCHEMA_VERSION =
  "practice-exercise-template.v1" as const;

export type PracticeExerciseTemplateSchemaVersion =
  typeof PRACTICE_EXERCISE_TEMPLATE_SCHEMA_VERSION;

export type PracticeConstraintSeverity = "hard" | "soft";
export type PracticeTaskType =
  | "analysis"
  | "implementation"
  | "review"
  | "debugging"
  | "planning";
export type PracticeOutputFormat = "json_object" | "markdown" | "text";

export interface PracticeConstraint {
  id: string;
  title: string;
  description: string;
  severity: PracticeConstraintSeverity;
  rationale?: string;
}

export interface PracticeScenario {
  id: string;
  title: string;
  input: Record<string, unknown>;
  context?: string;
  success_criteria: string[];
}

export interface PracticeExpectedOutputField {
  path: string;
  type: string;
  required: boolean;
  description: string;
}

export interface PracticeExpectedOutputShape {
  format: PracticeOutputFormat;
  fields: PracticeExpectedOutputField[];
  example?: Record<string, unknown> | string;
}

export interface PracticeExerciseTemplate {
  schema_version: PracticeExerciseTemplateSchemaVersion;
  id: string;
  title: string;
  summary: string;
  task_type: PracticeTaskType;
  scenarios: PracticeScenario[];
  constraints: PracticeConstraint[];
  expected_output_shape: PracticeExpectedOutputShape;
  tags?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
  opts: { required?: boolean } = {}
): string {
  const { required = true } = opts;
  const value = source[key];
  if (typeof value !== "string") {
    if (required) errors.push(`${key} must be a string`);
    return "";
  }
  const normalized = value.trim();
  if (!normalized && required) {
    errors.push(`${key} must not be empty`);
  }
  return normalized;
}

function readStringArray(
  source: Record<string, unknown>,
  key: string,
  errors: string[],
  opts: { required?: boolean; minItems?: number } = {}
): string[] {
  const { required = true, minItems = 0 } = opts;
  const value = source[key];
  if (!Array.isArray(value)) {
    if (required) errors.push(`${key} must be an array`);
    return [];
  }
  const output: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      errors.push(`${key}[${index}] must be a non-empty string`);
      return;
    }
    output.push(entry.trim());
  });
  if (output.length < minItems) {
    errors.push(`${key} must include at least ${minItems} item(s)`);
  }
  return output;
}

const TASK_TYPE_SET = new Set<PracticeTaskType>([
  "analysis",
  "implementation",
  "review",
  "debugging",
  "planning",
]);
const CONSTRAINT_SEVERITY_SET = new Set<PracticeConstraintSeverity>(["hard", "soft"]);
const OUTPUT_FORMAT_SET = new Set<PracticeOutputFormat>(["json_object", "markdown", "text"]);

function parseScenario(raw: unknown, index: number, errors: string[]): PracticeScenario | null {
  if (!isRecord(raw)) {
    errors.push(`scenarios[${index}] must be an object`);
    return null;
  }

  const id = readString(raw, "id", errors);
  const title = readString(raw, "title", errors);
  const input = raw.input;
  if (!isRecord(input)) {
    errors.push(`scenarios[${index}].input must be an object`);
  }
  const contextRaw = raw.context;
  const context =
    typeof contextRaw === "string" && contextRaw.trim() ? contextRaw.trim() : undefined;
  const successCriteria = readStringArray(raw, "success_criteria", errors, {
    minItems: 1,
  });

  if (!isRecord(input)) return null;

  return {
    id,
    title,
    input,
    context,
    success_criteria: successCriteria,
  };
}

function parseConstraint(
  raw: unknown,
  index: number,
  errors: string[]
): PracticeConstraint | null {
  if (!isRecord(raw)) {
    errors.push(`constraints[${index}] must be an object`);
    return null;
  }
  const id = readString(raw, "id", errors);
  const title = readString(raw, "title", errors);
  const description = readString(raw, "description", errors);
  const severityRaw = readString(raw, "severity", errors);
  if (!CONSTRAINT_SEVERITY_SET.has(severityRaw as PracticeConstraintSeverity)) {
    errors.push(`constraints[${index}].severity must be one of: hard, soft`);
  }
  const rationaleRaw = raw.rationale;
  const rationale =
    typeof rationaleRaw === "string" && rationaleRaw.trim() ? rationaleRaw.trim() : undefined;
  return {
    id,
    title,
    description,
    severity: severityRaw as PracticeConstraintSeverity,
    rationale,
  };
}

function parseExpectedOutputShape(
  raw: unknown,
  errors: string[]
): PracticeExpectedOutputShape | null {
  if (!isRecord(raw)) {
    errors.push("expected_output_shape must be an object");
    return null;
  }

  const format = readString(raw, "format", errors);
  if (!OUTPUT_FORMAT_SET.has(format as PracticeOutputFormat)) {
    errors.push("expected_output_shape.format must be one of: json_object, markdown, text");
  }

  const fieldsRaw = raw.fields;
  if (!Array.isArray(fieldsRaw)) {
    errors.push("expected_output_shape.fields must be an array");
    return null;
  }

  const fields: PracticeExpectedOutputField[] = [];
  fieldsRaw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`expected_output_shape.fields[${index}] must be an object`);
      return;
    }
    const path = readString(entry, "path", errors);
    const type = readString(entry, "type", errors);
    const required = entry.required;
    if (typeof required !== "boolean") {
      errors.push(`expected_output_shape.fields[${index}].required must be boolean`);
      return;
    }
    const description = readString(entry, "description", errors);
    fields.push({ path, type, required, description });
  });
  if (fields.length === 0) {
    errors.push("expected_output_shape.fields must include at least 1 field");
  }

  const exampleRaw = raw.example;
  const example =
    typeof exampleRaw === "string"
      ? exampleRaw
      : isRecord(exampleRaw)
        ? exampleRaw
        : undefined;
  if (
    typeof exampleRaw !== "undefined" &&
    typeof exampleRaw !== "string" &&
    !isRecord(exampleRaw)
  ) {
    errors.push("expected_output_shape.example must be a string or object");
  }

  return {
    format: format as PracticeOutputFormat,
    fields,
    example,
  };
}

export function validatePracticeExerciseTemplate(input: unknown): {
  ok: boolean;
  errors: string[];
  template: PracticeExerciseTemplate | null;
} {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: ["template must be an object"],
      template: null,
    };
  }

  const errors: string[] = [];
  const schemaVersion = readString(input, "schema_version", errors);
  if (schemaVersion !== PRACTICE_EXERCISE_TEMPLATE_SCHEMA_VERSION) {
    errors.push(
      `schema_version must equal "${PRACTICE_EXERCISE_TEMPLATE_SCHEMA_VERSION}"`
    );
  }
  const id = readString(input, "id", errors);
  const title = readString(input, "title", errors);
  const summary = readString(input, "summary", errors);

  const taskType = readString(input, "task_type", errors);
  if (!TASK_TYPE_SET.has(taskType as PracticeTaskType)) {
    errors.push(
      "task_type must be one of: analysis, implementation, review, debugging, planning"
    );
  }

  const scenariosRaw = input.scenarios;
  const scenarios: PracticeScenario[] = [];
  if (!Array.isArray(scenariosRaw)) {
    errors.push("scenarios must be an array");
  } else {
    scenariosRaw.forEach((entry, index) => {
      const parsed = parseScenario(entry, index, errors);
      if (parsed) scenarios.push(parsed);
    });
  }
  if (scenarios.length === 0) {
    errors.push("scenarios must include at least 1 scenario");
  }

  const constraintsRaw = input.constraints;
  const constraints: PracticeConstraint[] = [];
  if (!Array.isArray(constraintsRaw)) {
    errors.push("constraints must be an array");
  } else {
    constraintsRaw.forEach((entry, index) => {
      const parsed = parseConstraint(entry, index, errors);
      if (parsed) constraints.push(parsed);
    });
  }

  const expectedOutputShape = parseExpectedOutputShape(input.expected_output_shape, errors);
  const tags = readStringArray(input, "tags", errors, { required: false });

  const template: PracticeExerciseTemplate | null =
    errors.length === 0 && expectedOutputShape
      ? {
          schema_version: PRACTICE_EXERCISE_TEMPLATE_SCHEMA_VERSION,
          id,
          title,
          summary,
          task_type: taskType as PracticeTaskType,
          scenarios,
          constraints,
          expected_output_shape: expectedOutputShape,
          tags: tags.length > 0 ? tags : undefined,
        }
      : null;

  return { ok: errors.length === 0, errors, template };
}

export const PRACTICE_EXERCISE_TEMPLATE_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.useorgx.com/practice-exercise-template/v1.json",
  title: "OrgX Practice Exercise Template v1",
  description:
    "Structured exercise template for practice loops with scenarios, constraints, and expected output shape.",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "id",
    "title",
    "summary",
    "task_type",
    "scenarios",
    "constraints",
    "expected_output_shape",
  ],
  properties: {
    schema_version: {
      type: "string",
      const: PRACTICE_EXERCISE_TEMPLATE_SCHEMA_VERSION,
    },
    id: { type: "string", minLength: 1, maxLength: 120 },
    title: { type: "string", minLength: 1, maxLength: 300 },
    summary: { type: "string", minLength: 1, maxLength: 3000 },
    task_type: {
      type: "string",
      enum: ["analysis", "implementation", "review", "debugging", "planning"],
    },
    scenarios: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "input", "success_criteria"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 120 },
          title: { type: "string", minLength: 1, maxLength: 300 },
          input: { type: "object", additionalProperties: true },
          context: { type: "string", minLength: 1, maxLength: 4000 },
          success_criteria: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
      },
    },
    constraints: {
      type: "array",
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "description", "severity"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 120 },
          title: { type: "string", minLength: 1, maxLength: 300 },
          description: { type: "string", minLength: 1, maxLength: 2000 },
          severity: { type: "string", enum: ["hard", "soft"] },
          rationale: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
    expected_output_shape: {
      type: "object",
      additionalProperties: false,
      required: ["format", "fields"],
      properties: {
        format: { type: "string", enum: ["json_object", "markdown", "text"] },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "type", "required", "description"],
            properties: {
              path: { type: "string", minLength: 1, maxLength: 400 },
              type: { type: "string", minLength: 1, maxLength: 120 },
              required: { type: "boolean" },
              description: { type: "string", minLength: 1, maxLength: 2000 },
            },
          },
        },
        example: {
          oneOf: [
            { type: "string", minLength: 1, maxLength: 20000 },
            { type: "object", additionalProperties: true },
          ],
        },
      },
    },
    tags: {
      type: "array",
      maxItems: 30,
      items: { type: "string", minLength: 1, maxLength: 80 },
    },
  },
} as const;
