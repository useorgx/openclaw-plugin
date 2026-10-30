import type { OrgXClient } from "../contracts/client.js";
import { ARTIFACT_CONTENT_PROFILE, parseArtifactContentSnapshotInput } from "../contracts/generated/artifactContentInput.js";
import { defaultContractProfile, selectContractProfile } from "../contracts/generated/contractProfiles.js";
import { idempotencyKey, stableHash } from "../hash-utils.js";
import type { readLocalArtifactContent } from "./content-hash.js";

export type ContentCapture =
  | { state: "unavailable"; reason: string }
  | { state: "captured"; revision_uri: string; revision: number; digest: string; byte_length: number; current: boolean };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Discover before bytes are sent. A failed capture must never become a legacy create. */
export async function createCapturedArtifact(
  client: OrgXClient,
  body: Record<string, unknown>,
  content: NonNullable<Awaited<ReturnType<typeof readLocalArtifactContent>>>,
): Promise<{ response: unknown; capture: ContentCapture } | null> {
  if (content.contentBase64 === undefined) return null;
  const requested = defaultContractProfile("artifact_revision_witness");
  let profile;
  try {
    const catalog = await client.rawRequest<unknown>("GET", "/api/v1/meta/schemas");
    profile = selectContractProfile(record(record(catalog).data).contract_profiles, requested);
  } catch {
    return null;
  }
  const input = { ...body, content_snapshot: parseArtifactContentSnapshotInput({
    schemaVersion: "1.0.0", semanticProfile: ARTIFACT_CONTENT_PROFILE,
    contentBase64: content.contentBase64, mediaType: "application/octet-stream", declaredDigest: content.digest,
  }) };
  const response = await client.rawRequest<unknown>("POST", "/api/v1/artifacts", input, {
    idempotencyKey: idempotencyKey(["openclaw", "artifact-content", String(body.artifact_id), stableHash(JSON.stringify(input))]),
    contractProfile: { kind: profile.kind, wireVersion: profile.wireVersion, semanticProfile: profile.semanticProfile },
  });
  const envelope = record(response);
  const capture = record(record(envelope.meta).contentCapture);
  const witness = record(capture.witness);
  const bytes = record(witness.content);
  const revision = witness.revision;
  const uri = `orgx://artifact-revisions/${body.artifact_id}/${revision}`;
  if (record(envelope.data).id !== body.artifact_id || witness.artifactId !== body.artifact_id ||
      witness.schemaVersion !== "1.0.0" || witness.semanticProfile !== ARTIFACT_CONTENT_PROFILE ||
      !Number.isSafeInteger(revision) || Number(revision) < 1 || witness.revisionUri !== uri ||
      bytes.algorithm !== "sha256" || bytes.digest !== content.digest || bytes.byteLength !== content.byteLength ||
      bytes.mediaType !== "application/octet-stream" || record(witness.capture).state !== "captured" ||
      record(witness.capture).method !== "orgx.inline-bytes.v1" || typeof capture.current !== "boolean") {
    throw new Error("Artifact capture returned an inconsistent content revision; refresh its receipt before retrying");
  }
  return { response, capture: { state: "captured", revision_uri: uri, revision: Number(revision),
    digest: content.digest, byte_length: content.byteLength, current: capture.current } };
}
