import assert from "node:assert/strict";
import test from "node:test";

import { buildOmgmuCanonicalBatch } from "../src/adapters/omgmu/canonical.mjs";
import { buildWeeklyGridCanonicalCandidate } from "../src/adapters/omgmu/weekly-grid.mjs";
import { parseWeeklyGeometry } from "../src/adapters/omgmu/weekly-geometry.mjs";
import { materializeWeeklyUserSeries } from "../src/adapters/omgmu/weekly-o65.mjs";
import { applyApprovedWeeklyReview } from "../src/adapters/omgmu/weekly-reviewed.mjs";

function geometry() {
  return {
    version: 1,
    sourceProfile: "weekly_grid",
    sourceLanguage: "ru",
    pageNumber: 1,
    groups: [{ code: "101" }, { code: "102" }],
    rows: [
      {
        rowIndex: 1,
        weekday: 1,
        cells: [{
          groups: ["101"],
          bbox: [10, 10, 100, 30],
          text: "09.00-10.30 Анатомия 1 зан.: 07.09",
        }],
      },
    ],
  };
}

const metadata = {
  academicYear: "2026/2027",
  semester: "autumn",
  facultyCode: "medicine-international",
  facultyName: "Лечебный факультет",
  course: 1,
  group: "101",
  period: {
    start_date: "2026-09-01",
    end_date: "2026-12-31",
    week1_start_date: "2026-09-01",
  },
};

const source = { fileName: "official.pdf", fileHash: "sha256:test" };

test("weekly geometry parses Russian official geometry and retains evidence", () => {
  const parsed = parseWeeklyGeometry(geometry(), { year: 2026 });
  assert.deepEqual(parsed.groups, ["101", "102"]);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.series.length, 1);
  assert.equal(parsed.series[0].disciplineNormalized, "Анатомия");
  assert.deepEqual(parsed.series[0].dates, ["2026-09-07"]);
  assert.equal(parsed.series[0].status, "ok");
  assert.match(parsed.series[0].references[0].range, /^pdf:p1:row-1:/);
});

test("weekly grid builds canonical schedule batch without publishing", () => {
  const candidate = buildWeeklyGridCanonicalCandidate(geometry(), { metadata, source });
  assert.equal(candidate.batch.schema_version, "1.0");
  assert.equal(candidate.batch.schedule.university_code, "omgmu");
  assert.equal(candidate.batch.schedule.group, "101");
  assert.equal(candidate.batch.events.length, 1);
  assert.equal(candidate.batch.events[0].lesson.discipline.normalized, "Анатомия");
  assert.equal(candidate.batch.events[0].timing.date, "2026-09-07");
  assert.equal(candidate.batch.schedule.schedule_version_id, null);
});

test("canonical boundary rejects unresolved series without dates", () => {
  assert.throws(() => buildOmgmuCanonicalBatch({
    metadata,
    source,
    series: [{ discipline: "Анатомия", startTime: "09:00", endTime: "10:30", dates: [] }],
  }), /series\.dates must contain at least one resolved date/);
});

test("O65 merges only adjacent validated same-discipline rows", () => {
  const series = [
    {
      discipline: "Анатомия", disciplineNormalized: "Анатомия", kind: "unknown", status: "ok",
      startTime: "15:00", endTime: "15:55", dates: ["2026-09-07"], groups: ["101"],
      location: "", sourceNote: "", references: [{ role: "lesson", range: "a" }], ruleIds: [], warnings: [],
      geometry: { pageNumber: 1, rowIndex: 1, bbox: [0, 0, 1, 1], groups: ["101"] },
    },
    {
      discipline: "Анатомия", disciplineNormalized: "Анатомия", kind: "unknown", status: "ok",
      startTime: "16:00", endTime: "16:45", dates: ["2026-09-07"], groups: ["101"],
      location: "", sourceNote: "", references: [{ role: "lesson", range: "b" }], ruleIds: [], warnings: [],
      geometry: { pageNumber: 1, rowIndex: 2, bbox: [0, 0, 1, 1], groups: ["101"] },
    },
  ];
  const output = materializeWeeklyUserSeries(series, { group: "101" });
  assert.equal(output.userSeries.length, 1);
  assert.equal(output.userSeries[0].startTime, "15:00");
  assert.equal(output.userSeries[0].endTime, "16:45");
  assert.equal(output.userSeries[0].o65Merged, true);
  assert.deepEqual(output.userSeries[0].ruleIds, ["O65"]);
});

test("manual review is exact-source-bound and fails closed on hash change", () => {
  const parsed = parseWeeklyGeometry(geometry(), { year: 2026 });
  const registry = {
    version: 2,
    university: "omgmu",
    applicationConfirmedBy: "reviewer",
    applicationConfirmedOn: "2026-08-26",
    groups: [{
      status: "approved",
      group: "101",
      course: 1,
      stream: null,
      reason: "official source contradiction",
      reviewedBy: "reviewer",
      reviewedAt: "2026-08-26T00:00:00Z",
      sourceFile: "official.pdf",
      sourceSha256: "sha256:test",
      decision: "accept explicit date",
      canonicalResolution: {
        type: "accept-explicit-date",
        dates: ["2026-09-07"],
        match: {
          discipline: "Анатомия",
          startTime: "09:00",
          endTime: "10:30",
          dateExpression: "07.09",
        },
      },
    }],
  };
  const reviewed = applyApprovedWeeklyReview(parsed.series, { metadata, source, registry });
  assert.equal(reviewed.series[0].status, "warning");
  assert.throws(() => applyApprovedWeeklyReview(parsed.series, {
    metadata,
    source: { ...source, fileHash: "sha256:changed" },
    registry,
  }), (error) => error?.code === "OMG_WEEKLY_REVIEW_SOURCE_CHANGED");
});

test("weekly grid fails closed when requested group is absent", () => {
  assert.throws(() => buildWeeklyGridCanonicalCandidate(geometry(), {
    metadata: { ...metadata, group: "999" },
    source,
  }), (error) => error?.code === "OMG_WEEKLY_GRID_GROUP_NOT_FOUND");
});
