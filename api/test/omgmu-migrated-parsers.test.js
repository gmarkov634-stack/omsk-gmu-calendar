import assert from "node:assert/strict";
import test from "node:test";
import { extractGroupCodes, parseSourceFilename } from "../src/adapters/omgmu/catalog.mjs";
import { parseCombinedRotationGeometry } from "../src/adapters/omgmu/combined-rotation-table.mjs";
import { buildCourseLectureListCanonicalBatch } from "../src/adapters/omgmu/course-lecture-list.mjs";
import { parseFifthCourseBlocks } from "../src/adapters/omgmu/cycle-parser.mjs";
import { parseCycleRotationGeometry } from "../src/adapters/omgmu/cycle-rotation-grid.mjs";
import { parseFourthCourseLectures } from "../src/adapters/omgmu/fourth-parser.mjs";

test("migrated catalog helpers preserve OmGMU group and filename parsing", () => {
  assert.deepEqual(extractGroupCodes("Дисциплина 485 486"), ["485", "486"]);
  assert.deepEqual(parseSourceFilename("01_medicine_course-4_stream-A_lectures.txt"), {
    order: 1,
    program: "medicine",
    course: 4,
    stream: "A",
    part: "lectures",
  });
});

test("migrated fourth-course lecture parser resolves an explicit Monday date", () => {
  const text = `
РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ
ПОНЕДЕЛЬНИК
08.20-10.00 Неврология, 1 лекция: 06.04
`;
  const records = parseFourthCourseLectures(text);
  assert.equal(records.length, 1);
  assert.equal(records[0].discipline, "Неврология");
  assert.deepEqual(records[0].dates, ["2026-04-06"]);
  assert.equal(records[0].status, "ok");
});

test("migrated course lecture profile fails closed on an empty source", () => {
  assert.throws(
    () => buildCourseLectureListCanonicalBatch("", {}),
    (error) => error?.code === "OMG_COURSE_LECTURE_LIST_EMPTY",
  );
});

test("migrated fifth-course fixed-column parser resolves a lecture block", () => {
  const line1 = `${"Психиатрия".padEnd(30)}${"08.20-".padEnd(11)}06.04-13.04 (лекции)`;
  const line2 = `${"".padEnd(30)}${"10.00".padEnd(11)}`;
  const records = parseFifthCourseBlocks(`${line1}\n${line2}`);
  assert.equal(records.length, 1);
  assert.equal(records[0].discipline, "Психиатрия");
  assert.equal(records[0].kind, "lecture");
  assert.equal(records[0].startTime, "08:20");
  assert.equal(records[0].endTime, "10:00");
  assert.equal(records[0].dates.length, 6);
});

test("migrated combined rotation parser keeps a self-consistent row green", () => {
  const geometry = {
    version: 1,
    sourceProfile: "combined_rotation_table",
    sourceLanguage: "ru",
    columnSchema: { groupCode: "585" },
    localEnvelope: { start: "06.04", end: "13.04" },
    pages: [{
      pageNumber: 1,
      schemaInherited: false,
      schemaFromPage: null,
      rows: [{
        rowIndex: 1,
        discipline: "Психиатрия",
        disciplineInherited: false,
        timeText: "08.20-10.00",
        declaredDays: 6,
        groupCode: "585",
        groupText: "06.04-13.04 (лекции)",
        groupBbox: [0, 0, 1, 1],
      }],
    }],
  };
  const parsed = parseCombinedRotationGeometry(geometry, { year: 2026 });
  assert.equal(parsed.group, "585");
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.sourceSeries.length, 1);
  assert.equal(parsed.sourceSeries[0].status, "ok");
  assert.equal(parsed.sourceSeries[0].mainDates.length, 6);
});

test("migrated cycle rotation parser keeps a self-consistent group row green", () => {
  const geometry = {
    version: 1,
    sourceProfile: "cycle_rotation_grid",
    sourceLanguage: "ru",
    sourceCalendarExceptions: [],
    cycles: [{
      cycleNo: 1,
      pageNumber: 1,
      envelope: { start: "06.04", end: "13.04", withoutSaturday: true },
      groups: [{ code: "485" }],
      rows: [{
        rowIndex: 1,
        discipline: "Психиатрия",
        disciplineInherited: false,
        timeText: "08.20-10.00",
        declaredDays: 6,
        groupCells: [{
          text: "06.04-13.04 (лекции)",
          bbox: [0, 0, 1, 1],
          groups: ["485"],
        }],
      }],
    }],
  };
  const parsed = parseCycleRotationGeometry(geometry, { year: 2026 });
  assert.deepEqual(parsed.groups, ["485"]);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.sourceSeries.length, 1);
  assert.equal(parsed.sourceSeries[0].status, "ok");
  assert.equal(parsed.sourceSeries[0].mainDates.length, 6);
});
