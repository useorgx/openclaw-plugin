import { stableHash } from "../hash-utils.js";

export interface RandomizationArm {
  id: string;
  weight: number;
}

export interface RandomizationRequest {
  experimentId: string;
  subjectKey: string;
  channel: string;
  arms: RandomizationArm[];
  seed?: string;
}

export interface RandomizationResult {
  experimentId: string;
  subjectKey: string;
  channel: string;
  assignmentKey: string;
  exposureKey: string;
  bucket: number;
  armId: string;
}

const MAX_UINT53 = 0x1fffffffffffff;

export function randomizeExperimentAssignment(request: RandomizationRequest): RandomizationResult {
  const experimentId = sanitizeIdentifier(request.experimentId, "experimentId");
  const subjectKey = sanitizeIdentifier(request.subjectKey, "subjectKey");
  const channel = sanitizeIdentifier(request.channel, "channel");
  const normalizedArms = normalizeArms(request.arms);
  const seed = typeof request.seed === "string" && request.seed.trim().length > 0 ? request.seed.trim() : "v1";

  const assignmentKey = stableHash(`exp:${experimentId}:subject:${subjectKey}:seed:${seed}`);
  const bucket = bucketFromHash(assignmentKey);
  const armId = pickWeightedArm(bucket, normalizedArms);

  return {
    experimentId,
    subjectKey,
    channel,
    assignmentKey,
    exposureKey: stableHash(`exp:${experimentId}:subject:${subjectKey}:arm:${armId}:seed:${seed}`),
    bucket,
    armId,
  };
}

function normalizeArms(arms: RandomizationArm[]): RandomizationArm[] {
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new Error("arms must include at least one entry");
  }

  const sanitized = arms.map((arm, index) => {
    const id = sanitizeIdentifier(arm?.id, `arms[${index}].id`);
    const weight = Number.isFinite(arm?.weight) ? Number(arm.weight) : Number.NaN;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`arms[${index}].weight must be > 0`);
    }
    return { id, weight };
  });

  const totalWeight = sanitized.reduce((sum, arm) => sum + arm.weight, 0);
  if (totalWeight <= 0) {
    throw new Error("arms total weight must be > 0");
  }

  return sanitized.map((arm) => ({ id: arm.id, weight: arm.weight / totalWeight }));
}

function pickWeightedArm(bucket: number, arms: RandomizationArm[]): string {
  let cursor = 0;
  for (const arm of arms) {
    cursor += arm.weight;
    if (bucket < cursor) {
      return arm.id;
    }
  }

  return arms[arms.length - 1].id;
}

function sanitizeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} cannot be empty`);
  }

  return trimmed;
}

function bucketFromHash(hash: string): number {
  const first53Bits = hash.slice(0, 14);
  return parseInt(first53Bits, 16) / MAX_UINT53;
}
