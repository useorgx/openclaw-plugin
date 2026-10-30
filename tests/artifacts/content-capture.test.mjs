import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrgXClient } from "../../dist/contracts/client.js";
import { registerArtifact } from "../../dist/artifacts/register-artifact.js";
import { readLocalArtifactContent } from "../../dist/artifacts/content-hash.js";
import { ARTIFACT_CONTENT_PROFILE, MAX_ARTIFACT_CONTENT_BYTES } from "../../dist/contracts/generated/artifactContentInput.js";

const artifactId = "11111111-1111-4111-8111-111111111111";
const scopeId = "22222222-2222-4222-8222-222222222222";
const profile = { kind: "artifact_revision_witness", wireVersion: "1.0.0", semanticProfile: ARTIFACT_CONTENT_PROFILE };
const descriptor = { ...profile, schemaDigest: `sha256:${"a".repeat(64)}`, fixtureDigest: `sha256:${"b".repeat(64)}`,
  digestDomain: "raw-bytes.sha256.v1", commandOwner: "artifactContent", maxPayloadBytes: 1048576 };
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

async function fixture(t, bytes = Buffer.from([0, 255, 128, 10])) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orgx-inline-content-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "proof.bin");
  await writeFile(source, bytes);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  return { source, bytes, input: { artifact_id: artifactId, entity_type: "task", entity_id: scopeId,
    name: "Captured proof", artifact_type: "shared.project_handbook", external_url: source },
    client: new OrgXClient("oxk_test", "https://www.useorgx.com") };
}

function receipt(body) {
  return { data: { id: artifactId }, meta: { contentCapture: { current: true, revisionChanged: true, witness: {
    ...body.content_snapshot, contentBase64: undefined, declaredDigest: undefined,
    artifactId, workspaceId: scopeId, ownerId: scopeId, revision: 1,
    revisionUri: `orgx://artifact-revisions/${artifactId}/1`,
    content: { algorithm: "sha256", digest: body.content_snapshot.declaredDigest,
      byteLength: Buffer.from(body.content_snapshot.contentBase64, "base64").length, mediaType: "application/octet-stream" },
    capture: { state: "captured", method: "orgx.inline-bytes.v1", capturedAt: new Date().toISOString(), sourceLocator: body.artifact_url },
  } } } };
}

test("real transport discovers the exact profile, sends binary bytes and preserves retry identity", async (t) => {
  const f = await fixture(t);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (url.endsWith("/meta/schemas")) return json({ data: { contract_profiles: [descriptor] } });
    assert.ok(url.endsWith("/api/v1/artifacts"));
    return json(receipt(body));
  };
  const first = await registerArtifact(f.client, "https://www.useorgx.com", f.input);
  await registerArtifact(f.client, "https://www.useorgx.com", f.input);
  assert.equal(first.content_capture.state, "captured");
  assert.equal(first.content_capture.current, true);
  assert.deepEqual(Buffer.from(calls[1].body.content_snapshot.contentBase64, "base64"), f.bytes);
  assert.equal(first.content_capture.digest, `sha256:${createHash("sha256").update(f.bytes).digest("hex")}`);
  assert.deepEqual(JSON.parse(calls[1].init.headers["x-orgx-contract-profile"]), profile);
  assert.equal(calls[1].init.headers["Idempotency-Key"], calls[3].init.headers["Idempotency-Key"]);
  assert.ok(calls[1].init.headers.Authorization.startsWith("Bearer "));
  assert.equal(calls.length, 4);
});

for (const advertised of [[], [{ ...descriptor, wireVersion: "1.1.0" }]]) {
  test(`unsupported server records explicit unavailable capture (${advertised.length ? "future version" : "legacy"})`, async (t) => {
    const f = await fixture(t);
    const paths = [];
    globalThis.fetch = async (url, init) => {
      paths.push(url);
      if (url.endsWith("/meta/schemas")) return json({ data: { contract_profiles: advertised } });
      assert.ok(url.endsWith("/api/client/artifacts"));
      assert.equal(JSON.parse(init.body).content_snapshot, undefined);
      return json({ artifact: { id: artifactId } });
    };
    const result = await registerArtifact(f.client, "https://www.useorgx.com", f.input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.content_capture, { state: "unavailable", reason: "server_profile_unavailable" });
    assert.equal(paths.length, 2);
  });
}

for (const failure of ["lost response", "mismatched receipt"]) {
  test(`capture ${failure} never falls back to a legacy write`, async (t) => {
    const f = await fixture(t);
    const paths = [];
    globalThis.fetch = async (url, init) => {
      paths.push(url);
      if (url.endsWith("/meta/schemas")) return json({ data: { contract_profiles: [descriptor] } });
      assert.ok(url.endsWith("/api/v1/artifacts"));
      if (failure === "lost response") throw new TypeError("connection lost");
      const response = receipt(JSON.parse(init.body));
      response.meta.contentCapture.witness.content.digest = `sha256:${"f".repeat(64)}`;
      return json(response);
    };
    await assert.rejects(registerArtifact(f.client, "https://www.useorgx.com", f.input), /connection lost|inconsistent content revision/);
    assert.equal(paths.length, 2);
  });
}

test("inline limit includes the boundary and retains only a producer digest above it", async (t) => {
  const f = await fixture(t, Buffer.alloc(MAX_ARTIFACT_CONTENT_BYTES, 127));
  const boundary = await readLocalArtifactContent(f.source);
  assert.equal(Buffer.from(boundary.contentBase64, "base64").length, MAX_ARTIFACT_CONTENT_BYTES);
  await writeFile(f.source, Buffer.alloc(MAX_ARTIFACT_CONTENT_BYTES + 1));
  const oversized = await readLocalArtifactContent(f.source);
  assert.equal(oversized.contentBase64, undefined);
  assert.match(oversized.digest, /^sha256:/);
  globalThis.fetch = async (url, init) => {
    assert.ok(url.endsWith("/api/client/artifacts"));
    assert.equal(JSON.parse(init.body).content_snapshot, undefined);
    return json({ artifact: { id: artifactId } });
  };
  const result = await registerArtifact(f.client, "https://www.useorgx.com", f.input);
  assert.deepEqual(result.content_capture, { state: "unavailable", reason: "inline_content_limit" });
});
