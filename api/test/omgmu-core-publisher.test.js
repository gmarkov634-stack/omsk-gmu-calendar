import test from "node:test";
import assert from "node:assert/strict";

// CI content retrigger: 2026-08-26 publisher-boundary verification.
import {
  omgmuProductionPublisherBoundary,
  parseExpectedCurrentVersion,
  publishCanonicalBatch,
} from "../src/publisher/core-publisher.mjs";

function batch(university = "omgmu") {
  return {
    schema_version: "1.0",
    schedule: {
      university_code: university,
      academic_year: "2026/2027",
      semester: 1,
      faculty_code: "review-only",
      course: 1,
      group: "TEST",
      period: { start_date: "2026-09-01", end_date: "2026-12-31", week1_start_date: "2026-09-01" },
      source_files: [],
      generated_at: "2026-08-26T00:00:00.000Z",
      parser: { name: "test", version: "1" },
    },
    events: [],
  };
}

const TOKEN = "x".repeat(48);

test("production publisher boundary stays pinned to OmGMU and does not enable repository publication", () => {
  assert.equal(omgmuProductionPublisherBoundary.university, "omgmu");
  assert.equal(
    omgmuProductionPublisherBoundary.apiOrigin,
    "https://medical-calendar-core-omgmu-publisher.containerapps.ru",
  );
  assert.equal(omgmuProductionPublisherBoundary.schedulePublicationEnabledByRepository, false);
  assert.equal(omgmuProductionPublisherBoundary.tokenEnvironmentName, "OMGMU_PRODUCTION_SCHEDULE_PUBLISH_TOKEN");
});

test("publishes only to dedicated OmGMU publisher origin with explicit optimistic precondition", async () => {
  let request = null;
  const result = await publishCanonicalBatch({
    token: TOKEN,
    batch: batch(),
    expectedCurrentVersionId: null,
    fetchFn: async (url, init) => {
      request = { url, init };
      return new Response(
        JSON.stringify({
          status: "published",
          context: { university: "omgmu" },
          scheduleVersionId: "ver_test",
          eventCount: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(result.status, "published");
  assert.equal(request.url, "https://medical-calendar-core-omgmu-publisher.containerapps.ru/api/v1/admin/schedules/publish");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(request.init.body).expectedCurrentVersionId, null);
});

test("rejects cross-tenant and customer/staging publisher origins before network", async () => {
  for (const apiUrl of [
    "https://kgmu-calendar-api.containerapps.ru",
    "https://kgmu-calendar-tenant-control.containerapps.ru",
    "https://medical-calendar-core-ugmu-test.containerapps.ru",
    "https://medical-calendar-core-ugmu-publisher.containerapps.ru",
    "https://example.invalid",
  ]) {
    let called = false;
    await assert.rejects(
      () => publishCanonicalBatch({
        apiUrl,
        token: TOKEN,
        batch: batch(),
        expectedCurrentVersionId: null,
        fetchFn: async () => {
          called = true;
          throw new Error("must not call network");
        },
      }),
      (error) => ["PUBLISH_PRODUCTION_URL_FORBIDDEN", "PUBLISH_ORIGIN_MISMATCH"].includes(error.code),
    );
    assert.equal(called, false, apiUrl);
  }
});

test("rejects non-OmGMU batch and missing token before network", async () => {
  let called = false;
  await assert.rejects(
    () => publishCanonicalBatch({
      token: TOKEN,
      batch: batch("ugmu"),
      expectedCurrentVersionId: null,
      fetchFn: async () => {
        called = true;
        throw new Error("must not call network");
      },
    }),
    (error) => error.code === "PUBLISH_TENANT_MISMATCH",
  );
  assert.equal(called, false);

  await assert.rejects(
    () => publishCanonicalBatch({
      token: "short",
      batch: batch(),
      expectedCurrentVersionId: null,
      fetchFn: async () => {
        called = true;
        throw new Error("must not call network");
      },
    }),
    (error) => error.code === "PUBLISH_TOKEN_MISSING",
  );
  assert.equal(called, false);
});

test("expected current version parser is fail-closed", () => {
  assert.equal(parseExpectedCurrentVersion("none"), null);
  assert.equal(parseExpectedCurrentVersion("null"), null);
  assert.equal(parseExpectedCurrentVersion("ver_abc-123"), "ver_abc-123");
  assert.throws(() => parseExpectedCurrentVersion("latest"), (error) => error.code === "PUBLISH_PRECONDITION_INVALID");
});
