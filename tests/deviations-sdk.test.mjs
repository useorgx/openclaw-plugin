import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  computeDedupeKey,
  postDeviation,
} from "../dist/deviations-sdk.js";

describe("computeDedupeKey", () => {
  test("stable within a 10-minute bucket", () => {
    const skillId = "parameterize-tests";
    const t0 = new Date("2026-04-17T10:00:00Z");
    const t5 = new Date("2026-04-17T10:05:00Z");
    const t9 = new Date("2026-04-17T10:09:59Z");

    const k0 = computeDedupeKey({
      skillId,
      evidenceKind: "file_edit",
      evidenceRef: "/src/foo.py:42",
      capturedAt: t0,
    });
    const k5 = computeDedupeKey({
      skillId,
      evidenceKind: "file_edit",
      evidenceRef: "/src/foo.py:42",
      capturedAt: t5,
    });
    const k9 = computeDedupeKey({
      skillId,
      evidenceKind: "file_edit",
      evidenceRef: "/src/foo.py:42",
      capturedAt: t9,
    });

    assert.equal(k0, k5);
    assert.equal(k5, k9);
  });

  test("changes across bucket boundary", () => {
    const skillId = "parameterize-tests";
    const t0 = new Date("2026-04-17T10:09:30Z");
    const t1 = new Date("2026-04-17T10:11:30Z");

    const k0 = computeDedupeKey({
      skillId,
      evidenceKind: "file_edit",
      evidenceRef: "/src/foo.py:42",
      capturedAt: t0,
    });
    const k1 = computeDedupeKey({
      skillId,
      evidenceKind: "file_edit",
      evidenceRef: "/src/foo.py:42",
      capturedAt: t1,
    });

    assert.notEqual(k0, k1);
  });

  test("different ref produces different key", () => {
    const common = {
      skillId: "s",
      evidenceKind: "file_edit",
      capturedAt: new Date("2026-04-17T10:00:00Z"),
    };
    assert.notEqual(
      computeDedupeKey({ ...common, evidenceRef: "a" }),
      computeDedupeKey({ ...common, evidenceRef: "b" }),
    );
  });
});

describe("postDeviation", () => {
  const input = {
    skillId: "skill-1",
    evidenceKind: "file_edit",
    evidenceRef: "/src/foo.py:42",
    summary: "class-based test refactored to parametrize",
    applicationSource: "plugin_openclaw",
    confidence: 0.91,
  };

  test("sends POST with bearer auth and expected body shape", async () => {
    const captured = [];
    const fetchMock = async (url, init) => {
      captured.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ id: "dev-123", deduplicated: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await postDeviation(input, {
      apiBaseUrl: "https://useorgx.com",
      apiKey: "oxk_test",
      fetchImpl: fetchMock,
    });

    assert.equal(result.ok, true);
    assert.equal(result.id, "dev-123");
    assert.equal(result.deduplicated, false);
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0]?.url,
      "https://useorgx.com/api/v1/skills/skill-1/deviations",
    );
    const headers = captured[0]?.init?.headers;
    assert.equal(headers?.Authorization, "Bearer oxk_test");
    const body = JSON.parse(String(captured[0]?.init?.body));
    assert.equal(body.evidence_kind, "file_edit");
    assert.equal(body.application_source, "plugin_openclaw");
    assert.equal(typeof body.dedupe_key, "string");
    assert.equal(body.dedupe_key.length, 40);
  });

  test("reports deduplicated on server echo", async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ id: "dev-prior", deduplicated: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await postDeviation(input, {
      apiBaseUrl: "https://useorgx.com",
      apiKey: "oxk_test",
      fetchImpl: fetchMock,
    });

    assert.equal(result.ok, true);
    assert.equal(result.deduplicated, true);
    assert.equal(result.id, "dev-prior");
  });

  test("handles 4xx errors without throwing", async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ error: "Invalid body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    const result = await postDeviation(input, {
      apiBaseUrl: "https://useorgx.com",
      apiKey: "oxk_test",
      fetchImpl: fetchMock,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error, "Invalid body");
  });

  test("network failure produces structured error", async () => {
    const fetchMock = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await postDeviation(input, {
      apiBaseUrl: "https://useorgx.com",
      apiKey: "oxk_test",
      fetchImpl: fetchMock,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.error, "ECONNREFUSED");
  });
});
