import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPublicationPlan, publicationDecision, scheduleObjectKey } from "../src/adapters/omgmu/publish.mjs";

function schedule(group, overrides = {}) {
  return {
    university: "omgmu",
    program: "medicine-international",
    course: group.length === 3 ? 3 : 2,
    group: { id: `omgmu:medicine-international:2:${group}`, code: group },
    academicYear: "2026/27",
    semester: 1,
    events: [{ id: "1", title: "Анатомия", start: "2026-09-06T08:00:00+06:00", end: "2026-09-06T10:00:00+06:00" }],
    ...overrides,
  };
}

function resolveStorageKey(value) {
  const year = String(value?.academicYear || "").trim();
  const semester = Number(value?.semester);
  if (year !== "2026/27" || ![1, 2].includes(semester)) throw new Error("Missing publication period");
  return `tenant-storage/${value.university}/${value.group.id}/semester-${semester}.json`;
}

test("publisher policy has no customer order-context dependency", () => {
  const filename = fileURLToPath(new URL("../src/adapters/omgmu/publish.mjs", import.meta.url));
  const source = fs.readFileSync(filename, "utf8");
  assert.doesNotMatch(source, /order-context/);
});

test("requires an injected storage-key resolver for publication plans", () => {
  assert.throws(() => buildPublicationPlan([schedule("2101")]), /storage-key resolver is required/);
});

test("delegates canonical storage-key resolution to composition boundary", () => {
  assert.equal(
    scheduleObjectKey(schedule("2101"), resolveStorageKey),
    "tenant-storage/omgmu/omgmu:medicine-international:2:2101/semester-1.json",
  );
});

test("publishes an automatically verified group", () => {
  assert.deepEqual(publicationDecision(schedule("2101"), resolveStorageKey), {
    publish: true,
    reason: "verified",
    key: "tenant-storage/omgmu/omgmu:medicine-international:2:2101/semester-1.json",
  });
});

test("blocks a schedule without an academic period", () => {
  assert.deepEqual(
    publicationDecision(schedule("2101", { academicYear: null, semester: null }), resolveStorageKey),
    { publish: false, reason: "missing-publication-period" },
  );
});

test("blocks a pending manual-review group without resolving a storage key", () => {
  let resolverCalls = 0;
  const decision = publicationDecision(schedule("2113"), () => {
    resolverCalls += 1;
    return "must-not-be-called";
  });
  assert.deepEqual(decision, { publish: false, reason: "manual-review-pending" });
  assert.equal(resolverCalls, 0);
});

test("publishes only trusted approved manual events", () => {
  const approved = schedule("2113", {
    review: { status: "approved", sourceSha256: "abc" },
    events: [{ id: "m1", title: "Анатомия", start: "2026-09-06T08:00:00+06:00", end: "2026-09-06T10:00:00+06:00", sourceType: "manual-review" }],
  });
  assert.equal(publicationDecision(approved, resolveStorageKey).publish, true);
});

test("publication plan keeps blocked entries fail-closed with key null", () => {
  const plan = buildPublicationPlan([schedule("2101"), schedule("2113")], resolveStorageKey);
  assert.equal(plan.publishable.length, 1);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].reason, "manual-review-pending");
  assert.equal(plan.blocked[0].key, null);
  assert.equal(plan.publishable[0].key, "tenant-storage/omgmu/omgmu:medicine-international:2:2101/semester-1.json");
});
