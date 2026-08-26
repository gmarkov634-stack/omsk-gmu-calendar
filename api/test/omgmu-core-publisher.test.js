import assert from "node:assert/strict";
import test from "node:test";

import { parseExpectedCurrentVersion, publishCanonicalBatch } from "../src/publisher/core-publisher.mjs";

const token = "o".repeat(48);
const apiUrl = "https://medical-calendar-core-omgmu-publisher.containerapps.ru";
const batch = {
  schema_version: "1.0",
  schedule: {
    university_code: "omgmu",
    program: "medicine",
    group: "101",
    academic_year: "2026-2027",
    semester: "autumn",
  },
  events: [],
};

function okResponse(overrides = {}) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status: "published",
        context: { university: "omgmu" },
        scheduleVersionId: "ver_test",
        ...overrides,
      });
    },
  };
}

test("OmGMU publisher bridge posts only OmGMU Schedule Batch v1 with optimistic current-version guard", async () => {
  let request = null;
  const result = await publishCanonicalBatch({
    apiUrl,
    token,
    batch,
    expectedCurrentVersionId: null,
    fetchFn: async (url, init) => {
      request = { url, init };
      return okResponse();
    },
  });

  assert.equal(result.status, "published");
  assert.equal(request.url, `${apiUrl}/api/v1/admin/schedules/publish`);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.authorization, `Bearer ${token}`);
  const body = JSON.parse(request.init.body);
  assert.equal(body.batch.schedule.university_code, "omgmu");
  assert.equal(body.expectedCurrentVersionId, null);
});

test("OmGMU publisher bridge fails closed for customer, UGMU publisher and staging origins", async () => {
  for (const forbidden of [
    "https://kgmu-calendar-api.containerapps.ru",
    "https://medical-calendar-core-ugmu-publisher.containerapps.ru",
    "https://medical-calendar-core-ugmu-test.containerapps.ru",
  ]) {
    await assert.rejects(
      publishCanonicalBatch({ apiUrl: forbidden, token, batch, expectedCurrentVersionId: null, fetchFn: async () => okResponse() }),
      (error) => error?.code === "PUBLISH_PRODUCTION_URL_FORBIDDEN",
    );
  }
});

test("OmGMU publisher bridge rejects other university batches before network access", async () => {
  let called = false;
  await assert.rejects(
    publishCanonicalBatch({
      apiUrl,
      token,
      batch: { ...batch, schedule: { ...batch.schedule, university_code: "ugmu" } },
      expectedCurrentVersionId: null,
      fetchFn: async () => { called = true; return okResponse(); },
    }),
    (error) => error?.code === "PUBLISH_TENANT_MISMATCH",
  );
  assert.equal(called, false);
});

test("OmGMU publisher bridge requires bearer token and valid expected version", async () => {
  await assert.rejects(
    publishCanonicalBatch({ apiUrl, token: "short", batch, expectedCurrentVersionId: null, fetchFn: async () => okResponse() }),
    (error) => error?.code === "PUBLISH_TOKEN_MISSING",
  );
  assert.equal(parseExpectedCurrentVersion("none"), null);
  assert.equal(parseExpectedCurrentVersion("ver_abc-123"), "ver_abc-123");
  assert.throws(() => parseExpectedCurrentVersion("abc"), (error) => error?.code === "PUBLISH_PRECONDITION_INVALID");
});
