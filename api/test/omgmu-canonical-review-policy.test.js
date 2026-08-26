import assert from "node:assert/strict";
import test from "node:test";
import {
  createOmgmuCanonicalReviewPolicy,
  OMGMU_CANONICAL_REVIEW_FORMAT,
  OMGMU_CANONICAL_REVIEW_PARSER_TYPE,
} from "../src/adapters/omgmu/canonical-reviewed.mjs";

const SHA = "a".repeat(64);

function normalizeAcademicYear(value) {
  return String(value ?? "").replace(/\s+/g, "").replace("-", "/");
}

function scheduleContext(batch) {
  return batch._context;
}

function prepareSchedulePublication(batch, { previousBatch, now } = {}) {
  const context = scheduleContext(batch);
  const prepared = structuredClone(batch);
  prepared.schedule.schedule_version_id = `version-${context.groupCode}`;
  prepared.schedule.previous_schedule_version_id = previousBatch?.schedule?.schedule_version_id || null;
  prepared.schedule.content_fingerprint = `fingerprint-${context.groupCode}`;
  return {
    batch: prepared,
    context,
    diff: { changed: true, now: now || null },
  };
}

function dependencies(overrides = {}) {
  return {
    normalizeAcademicYear,
    scheduleContext,
    validateScheduleBatch: () => ({ publishable: true, errors: [], warnings: [] }),
    prepareSchedulePublication,
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    university: "omgmu",
    status: "READY",
    sourceSha256: SHA,
    metadata: {
      filename: "schedule.pdf",
      program: "medicine",
      course: 4,
      academicYear: "2026/2027",
      semester: "autumn",
    },
    ...overrides,
  };
}

function batch(groupCode = "485", overrides = {}) {
  return {
    schema_version: "1.0",
    _context: {
      university: "omgmu",
      program: "medicine",
      course: 4,
      stream: null,
      groupCode,
      groupId: `omgmu-medicine-4-${groupCode}`,
      academicYear: "2026/2027",
      semester: 1,
    },
    schedule: {
      group: groupCode,
      source_files: ["schedule.pdf"],
      ...overrides.schedule,
    },
    events: overrides.events || [{
      title: "Неврология",
      source: {
        file_name: "schedule.pdf",
        file_hash: SHA,
      },
    }],
  };
}

function input(batches = [batch()]) {
  return {
    format: OMGMU_CANONICAL_REVIEW_FORMAT,
    rules_revision: "omgmu-rules-2026-08-26",
    batches,
  };
}

test("canonical review policy fails closed when a core dependency is missing", () => {
  assert.throws(
    () => createOmgmuCanonicalReviewPolicy({}),
    (error) => error.code === "CANONICAL_REVIEW_DEPENDENCY_MISSING" && error.details?.dependency === "normalizeAcademicYear",
  );
});

test("canonical review validation preserves source evidence and QA boundary", () => {
  const policy = createOmgmuCanonicalReviewPolicy(dependencies());
  const normalized = policy.validateOmgmuCanonicalReviewPackage(input(), review({ sourceSha256: SHA.toUpperCase() }));

  assert.equal(normalized.format, OMGMU_CANONICAL_REVIEW_FORMAT);
  assert.equal(normalized.parserType, OMGMU_CANONICAL_REVIEW_PARSER_TYPE);
  assert.equal(normalized.sourceSha256, SHA);
  assert.equal(normalized.qa.status, "PASS");
  assert.deepEqual(normalized.qa.groups, ["485"]);
  assert.equal(normalized.qa.reviewedSourceEventCount, 1);
  assert.equal(normalized.batches[0].events[0].source.file_hash, `sha256:${SHA}`);
});

test("canonical review rejects cross-university context", () => {
  const policy = createOmgmuCanonicalReviewPolicy(dependencies());
  const wrong = batch();
  wrong._context.university = "kgmu";

  assert.throws(
    () => policy.validateOmgmuCanonicalReviewPackage(input([wrong]), review()),
    (error) => error.code === "CANONICAL_REVIEW_CONTEXT_MISMATCH",
  );
});

test("canonical review rejects a batch that fails injected QA", () => {
  const policy = createOmgmuCanonicalReviewPolicy(dependencies({
    validateScheduleBatch: () => ({ publishable: false, errors: ["bad-event"], warnings: [] }),
  }));

  assert.throws(
    () => policy.validateOmgmuCanonicalReviewPackage(input(), review()),
    (error) => error.code === "CANONICAL_REVIEW_QA_FAILED" && error.details?.errors?.includes("bad-event"),
  );
});

test("canonical review staging stores the normalized package under reviewed source SHA", async () => {
  const policy = createOmgmuCanonicalReviewPolicy(dependencies());
  const calls = [];
  const staged = await policy.stageOmgmuCanonicalReviewPackage({
    input: input(),
    review: review(),
    queue: {
      async storeNormalized(sourceSha256, normalized) {
        calls.push({ sourceSha256, normalized });
        return "normalized/review-485.json";
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceSha256, SHA);
  assert.equal(calls[0].normalized.qa.status, "PASS");
  assert.equal(staged.normalizedKey, "normalized/review-485.json");
});

test("canonical review publication uses injected pipeline and schedule store", async () => {
  const policy = createOmgmuCanonicalReviewPolicy(dependencies());
  const normalized = policy.validateOmgmuCanonicalReviewPackage(input(), review());
  const writes = [];
  const result = await policy.publishStagedOmgmuCanonicalReview({
    queue: { async getNormalized(key) { assert.equal(key, "normalized/key"); return normalized; } },
    scheduleStore: {
      async getSchedule(request) {
        assert.equal(request.university, "omgmu");
        assert.equal(request.groupCode, "485");
        return {
          schema_version: "1.0",
          schedule: { schedule_version_id: "previous-485" },
          events: [],
        };
      },
      async putSchedule(value) {
        writes.push(value);
        return { stored: true };
      },
    },
    review: {
      normalizedKey: "normalized/key",
      qa: { status: "PASS" },
      parserType: OMGMU_CANONICAL_REVIEW_PARSER_TYPE,
      normalizer: { format: OMGMU_CANONICAL_REVIEW_FORMAT },
      sourceSha256: SHA,
    },
    now: "2026-08-26T18:00:00.000Z",
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].schedule.previous_schedule_version_id, "previous-485");
  assert.equal(result.groupCount, 1);
  assert.deepEqual(result.groups, ["485"]);
  assert.equal(result.publications[0].scheduleVersionId, "version-485");
});

test("canonical review publication preserves partial-publication failure semantics", async () => {
  const policy = createOmgmuCanonicalReviewPolicy(dependencies());
  const normalized = policy.validateOmgmuCanonicalReviewPackage(input([batch("485"), batch("486")]), review());
  let writes = 0;

  await assert.rejects(
    () => policy.publishStagedOmgmuCanonicalReview({
      queue: { async getNormalized() { return normalized; } },
      scheduleStore: {
        async getSchedule() { return null; },
        async putSchedule() {
          writes += 1;
          if (writes === 2) throw new Error("store unavailable");
          return { stored: true };
        },
      },
      review: {
        normalizedKey: "normalized/key",
        qa: { status: "PASS" },
        parserType: OMGMU_CANONICAL_REVIEW_PARSER_TYPE,
        normalizer: { format: OMGMU_CANONICAL_REVIEW_FORMAT },
        sourceSha256: SHA,
      },
    }),
    (error) => error.code === "CANONICAL_PUBLICATION_PARTIAL" && error.details?.publishedGroups?.join(",") === "485",
  );
});
