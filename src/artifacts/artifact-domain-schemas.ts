/**
 * Domain artifact metadata schemas for the OrgX Proof Ladder.
 *
 * Each domain has one or more canonical "atomic unit types" with required
 * metadata fields. Validation is warn-only in phase 1 — artifacts that fail
 * schema checks are still registered but tagged with `schema_validated: false`.
 */

import type { OrgxAgentDomain } from "../contracts/types.js";

// ---------------------------------------------------------------------------
// Canonical atomic unit types per domain
// ---------------------------------------------------------------------------

export const ATOMIC_UNIT_TYPES = [
  // Engineering
  "engineering.commit",
  "engineering.pr",
  // Product
  "product.spec",
  "product.decision",
  // Design
  "design.component",
  "design.a11y",
  // Marketing
  "marketing.asset",
  "marketing.experiment",
  // Sales
  "sales.qualification",
  "sales.proposal",
  // Operations
  "operations.runbook",
  "operations.incident",
  // Orchestration
  "orchestration.routing",
  "orchestration.decomp",
] as const;

export type AtomicUnitType = (typeof ATOMIC_UNIT_TYPES)[number];

// ---------------------------------------------------------------------------
// Queue / Run / Artifact refs (shared receipt metadata)
// ---------------------------------------------------------------------------

export interface QueueRef {
  initiative_id?: string;
  workstream_id?: string;
  task_id?: string;
  queue_snapshot?: Record<string, unknown>;
}

export interface RunRef {
  run_id?: string;
  correlation_id?: string;
  session_id?: string;
}

export interface QualityGateRef {
  passed: boolean;
  score: number;
  threshold: number;
}

// ---------------------------------------------------------------------------
// Per-type required fields
// ---------------------------------------------------------------------------

interface FieldSpec {
  /** Human-readable name */
  label: string;
  /** When true, warn if missing */
  required: boolean;
}

type SchemaFields = Record<string, FieldSpec>;

const ENGINEERING_COMMIT_FIELDS: SchemaFields = {
  commit_sha: { label: "Commit SHA", required: true },
  branch: { label: "Branch name", required: true },
  diff_summary: { label: "Diff summary", required: false },
  "verification.tests_passed": { label: "Tests passed", required: false },
  "verification.lint_passed": { label: "Lint passed", required: false },
  "verification.build_passed": { label: "Build passed", required: false },
};

const ENGINEERING_PR_FIELDS: SchemaFields = {
  pr_url: { label: "PR URL", required: true },
  branch: { label: "Branch name", required: true },
  commit_count: { label: "Commit count", required: false },
  ci_status: { label: "CI status", required: false },
};

const PRODUCT_SPEC_FIELDS: SchemaFields = {
  acceptance_criteria: { label: "Acceptance criteria", required: true },
  constraints: { label: "Constraints", required: false },
  success_metric: { label: "Success metric", required: true },
};

const PRODUCT_DECISION_FIELDS: SchemaFields = {
  decision_context: { label: "Decision context", required: true },
  options: { label: "Options considered", required: false },
  recommendation: { label: "Recommendation", required: true },
};

const DESIGN_COMPONENT_FIELDS: SchemaFields = {
  evidence_url: { label: "Evidence URL", required: true },
  tokens_referenced: { label: "Tokens referenced", required: false },
  viewport_evidence: { label: "Viewport evidence", required: false },
};

const DESIGN_A11Y_FIELDS: SchemaFields = {
  audit_results: { label: "Audit results", required: true },
  wcag_level: { label: "WCAG level", required: false },
  remediation_notes: { label: "Remediation notes", required: false },
};

const MARKETING_ASSET_FIELDS: SchemaFields = {
  audience: { label: "Target audience", required: true },
  channel: { label: "Channel", required: true },
  promise: { label: "Promise/value prop", required: false },
  cta: { label: "Call to action", required: false },
  measurement_hook: { label: "Measurement hook", required: true },
};

const MARKETING_EXPERIMENT_FIELDS: SchemaFields = {
  variant_id: { label: "Variant ID", required: true },
  hypothesis: { label: "Hypothesis", required: true },
  metric_target: { label: "Metric target", required: false },
};

const SALES_QUALIFICATION_FIELDS: SchemaFields = {
  buyer_stage: { label: "Buyer stage", required: true },
  meddic_fields: { label: "MEDDIC fields", required: false },
  next_action: { label: "Next action", required: true },
};

const SALES_PROPOSAL_FIELDS: SchemaFields = {
  recipient: { label: "Recipient", required: true },
  value_prop: { label: "Value proposition", required: false },
  pricing_summary: { label: "Pricing summary", required: false },
};

const OPERATIONS_RUNBOOK_FIELDS: SchemaFields = {
  change_description: { label: "Change description", required: true },
  rollback_path: { label: "Rollback path", required: true },
  affected_systems: { label: "Affected systems", required: true },
};

const OPERATIONS_INCIDENT_FIELDS: SchemaFields = {
  incident_id: { label: "Incident ID", required: true },
  severity: { label: "Severity", required: true },
  resolution_steps: { label: "Resolution steps", required: false },
  detection_method: { label: "Detection method", required: false },
};

const ORCHESTRATION_ROUTING_FIELDS: SchemaFields = {
  action_type: { label: "Action type", required: true },
  target_entity_ids: { label: "Target entity IDs", required: true },
  rationale: { label: "Rationale", required: true },
  unblocked_work: { label: "Unblocked work", required: false },
};

const ORCHESTRATION_DECOMP_FIELDS: SchemaFields = {
  parent_entity_id: { label: "Parent entity ID", required: true },
  child_tasks: { label: "Child tasks", required: true },
  sequencing: { label: "Sequencing info", required: false },
};

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

export interface DomainArtifactSchema {
  atomicUnitType: AtomicUnitType;
  domain: OrgxAgentDomain;
  receiptName: string;
  fields: SchemaFields;
}

export const DOMAIN_ARTIFACT_SCHEMAS: Record<AtomicUnitType, DomainArtifactSchema> = {
  "engineering.commit": {
    atomicUnitType: "engineering.commit",
    domain: "engineering",
    receiptName: "commit_or_pr_receipt",
    fields: ENGINEERING_COMMIT_FIELDS,
  },
  "engineering.pr": {
    atomicUnitType: "engineering.pr",
    domain: "engineering",
    receiptName: "commit_or_pr_receipt",
    fields: ENGINEERING_PR_FIELDS,
  },
  "product.spec": {
    atomicUnitType: "product.spec",
    domain: "product",
    receiptName: "decision_spec_receipt",
    fields: PRODUCT_SPEC_FIELDS,
  },
  "product.decision": {
    atomicUnitType: "product.decision",
    domain: "product",
    receiptName: "decision_spec_receipt",
    fields: PRODUCT_DECISION_FIELDS,
  },
  "design.component": {
    atomicUnitType: "design.component",
    domain: "design",
    receiptName: "design_spec_or_a11y_receipt",
    fields: DESIGN_COMPONENT_FIELDS,
  },
  "design.a11y": {
    atomicUnitType: "design.a11y",
    domain: "design",
    receiptName: "design_spec_or_a11y_receipt",
    fields: DESIGN_A11Y_FIELDS,
  },
  "marketing.asset": {
    atomicUnitType: "marketing.asset",
    domain: "marketing",
    receiptName: "experiment_asset_receipt",
    fields: MARKETING_ASSET_FIELDS,
  },
  "marketing.experiment": {
    atomicUnitType: "marketing.experiment",
    domain: "marketing",
    receiptName: "experiment_asset_receipt",
    fields: MARKETING_EXPERIMENT_FIELDS,
  },
  "sales.qualification": {
    atomicUnitType: "sales.qualification",
    domain: "sales",
    receiptName: "stage_advance_artifact_receipt",
    fields: SALES_QUALIFICATION_FIELDS,
  },
  "sales.proposal": {
    atomicUnitType: "sales.proposal",
    domain: "sales",
    receiptName: "stage_advance_artifact_receipt",
    fields: SALES_PROPOSAL_FIELDS,
  },
  "operations.runbook": {
    atomicUnitType: "operations.runbook",
    domain: "operations",
    receiptName: "runbook_or_incident_receipt",
    fields: OPERATIONS_RUNBOOK_FIELDS,
  },
  "operations.incident": {
    atomicUnitType: "operations.incident",
    domain: "operations",
    receiptName: "runbook_or_incident_receipt",
    fields: OPERATIONS_INCIDENT_FIELDS,
  },
  "orchestration.routing": {
    atomicUnitType: "orchestration.routing",
    domain: "orchestration",
    receiptName: "delegation_closure_receipt",
    fields: ORCHESTRATION_ROUTING_FIELDS,
  },
  "orchestration.decomp": {
    atomicUnitType: "orchestration.decomp",
    domain: "orchestration",
    receiptName: "delegation_closure_receipt",
    fields: ORCHESTRATION_DECOMP_FIELDS,
  },
};

// ---------------------------------------------------------------------------
// Domain → atomic unit type mapping
// ---------------------------------------------------------------------------

export const DOMAIN_DEFAULT_ATOMIC_TYPES: Record<OrgxAgentDomain, AtomicUnitType[]> = {
  engineering: ["engineering.commit", "engineering.pr"],
  product: ["product.spec", "product.decision"],
  design: ["design.component", "design.a11y"],
  marketing: ["marketing.asset", "marketing.experiment"],
  sales: ["sales.qualification", "sales.proposal"],
  operations: ["operations.runbook", "operations.incident"],
  orchestration: ["orchestration.routing", "orchestration.decomp"],
};

// ---------------------------------------------------------------------------
// Quality thresholds per domain
// ---------------------------------------------------------------------------

export const DOMAIN_QUALITY_THRESHOLDS: Record<OrgxAgentDomain, number> = {
  engineering: 4,
  product: 4,
  design: 4,
  operations: 4,
  marketing: 3,
  sales: 3,
  orchestration: 3,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ArtifactValidationResult {
  valid: boolean;
  atomicUnitType: string;
  missingRequired: string[];
  missingOptional: string[];
  warnings: string[];
}

/**
 * Resolve a nested dotted path (e.g. "verification.tests_passed") from
 * a flat or nested metadata object.
 */
function resolveField(metadata: Record<string, unknown>, path: string): unknown {
  // Try flat key first (some callers store "verification.tests_passed" as-is)
  if (path in metadata) return metadata[path];
  // Try nested
  const parts = path.split(".");
  let current: unknown = metadata;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isPresent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Validate artifact metadata against its domain schema.
 *
 * Returns validation result with missing fields listed. In phase 1 this is
 * advisory (warn-only); callers should not block artifact registration.
 */
export function validateArtifactMetadata(
  atomicUnitType: string,
  metadata: Record<string, unknown>
): ArtifactValidationResult {
  const schema = DOMAIN_ARTIFACT_SCHEMAS[atomicUnitType as AtomicUnitType];

  if (!schema) {
    return {
      valid: true, // unknown types pass through for backward compat
      atomicUnitType,
      missingRequired: [],
      missingOptional: [],
      warnings: [`Unknown atomic_unit_type "${atomicUnitType}"; skipping schema validation.`],
    };
  }

  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const warnings: string[] = [];

  for (const [fieldPath, spec] of Object.entries(schema.fields)) {
    const value = resolveField(metadata, fieldPath);
    if (!isPresent(value)) {
      if (spec.required) {
        missingRequired.push(fieldPath);
      } else {
        missingOptional.push(fieldPath);
      }
    }
  }

  if (missingRequired.length > 0) {
    warnings.push(
      `Missing required field(s) for ${atomicUnitType}: ${missingRequired.join(", ")}`
    );
  }

  return {
    valid: missingRequired.length === 0,
    atomicUnitType,
    missingRequired,
    missingOptional,
    warnings,
  };
}

/**
 * Infer the canonical atomic unit type from a freeform artifact_type string.
 *
 * Maps existing artifact_type conventions (e.g. "eng.diff_pack",
 * "shared.project_handbook") into one of the 14 canonical types.
 * Returns null if no mapping is found — the artifact still registers
 * but won't be schema-validated.
 */
export function normalizeArtifactType(artifactType: string): AtomicUnitType | null {
  const normalized = artifactType.trim().toLowerCase();

  // Direct canonical match
  if (ATOMIC_UNIT_TYPES.includes(normalized as AtomicUnitType)) {
    return normalized as AtomicUnitType;
  }

  // Engineering aliases
  if (
    normalized.startsWith("eng.") ||
    normalized.includes("diff_pack") ||
    normalized.includes("commit")
  ) {
    return "engineering.commit";
  }
  if (normalized.includes("pull_request") || normalized.includes("pr")) {
    return "engineering.pr";
  }

  // Product aliases
  if (normalized.includes("spec") || normalized.includes("prd")) {
    return "product.spec";
  }
  if (normalized.includes("decision")) {
    return "product.decision";
  }

  // Design aliases
  if (normalized.includes("component") || normalized.includes("design_spec")) {
    return "design.component";
  }
  if (normalized.includes("a11y") || normalized.includes("accessibility")) {
    return "design.a11y";
  }

  // Marketing aliases
  if (normalized.includes("campaign") || normalized.includes("channel_asset")) {
    return "marketing.asset";
  }
  if (normalized.includes("experiment") || normalized.includes("variant")) {
    return "marketing.experiment";
  }

  // Sales aliases
  if (normalized.includes("qualification") || normalized.includes("meddic")) {
    return "sales.qualification";
  }
  if (normalized.includes("proposal")) {
    return "sales.proposal";
  }

  // Operations aliases
  if (normalized.includes("runbook") || normalized.includes("process_change")) {
    return "operations.runbook";
  }
  if (normalized.includes("incident")) {
    return "operations.incident";
  }

  // Orchestration aliases
  if (normalized.includes("routing") || normalized.includes("delegation")) {
    return "orchestration.routing";
  }
  if (normalized.includes("decomp") || normalized.includes("breakdown")) {
    return "orchestration.decomp";
  }

  return null;
}
