import assert from "node:assert/strict";
import test from "node:test";
import {
  OMG_SOURCE_PROFILES,
  assertOmgmuSourceProfile,
  detectOmgmuSourceProfile,
  rulesForOmgmuSourceProfile,
} from "../src/adapters/omgmu/source-profiles.mjs";

const weekly = `
1101 1102 1103 1104
Monday
08.00-10.25 Histology
Tuesday
11.00-12.40 Biochemistry
Wednesday
Thursday
Friday
Saturday
`;

const lectures = `
4 COURSE
LECTURES
MONDAY
08.00-09.40 Neurology
TUESDAY
08.20-10.00 Reproductology
WEDNESDAY
THURSDAY
FRIDAY
`;

const cycles = `
1 cycle: 07.05-31.07 - without Saturday
Discipline Time N. of d. 485 486
Faculty therapy 08.20-10.00 11 07.05-21.05 (lectures)
2 cycle: 29.05-30.07 - without Saturday
Discipline Time N. of d. 485 486
Pediatrics 12.50-16.00 10 30.06-13.07
`;

const combined = `
5 COURSE
Auditorium classes: 06.04-07.08 - without Saturday
Discipline Time N. of d 585
Psychiatry 08.20-10.00 6 06.04-13.04 (lectures)
Psychiatry 10.40-13.50 8 06.04-15.04 (cycles)
`;

test("classifies all four OmGMU source profiles", () => {
  assert.equal(detectOmgmuSourceProfile(weekly).profile, OMG_SOURCE_PROFILES.WEEKLY_GRID);
  assert.equal(detectOmgmuSourceProfile(lectures).profile, OMG_SOURCE_PROFILES.COURSE_LECTURE_LIST);
  assert.equal(detectOmgmuSourceProfile(cycles).profile, OMG_SOURCE_PROFILES.CYCLE_ROTATION_GRID);
  assert.equal(detectOmgmuSourceProfile(combined).profile, OMG_SOURCE_PROFILES.COMBINED_ROTATION_TABLE);
});

test("unknown structure fails closed", () => {
  const result = detectOmgmuSourceProfile("Schedule with dates only");
  assert.equal(result.status, "needs_review");
  assert.equal(result.profile, null);
  assert.throws(() => assertOmgmuSourceProfile("unknown", OMG_SOURCE_PROFILES.WEEKLY_GRID), /profile mismatch/);
});

test("rule registry keeps common and profile-specific rules", () => {
  const weeklyRules = rulesForOmgmuSourceProfile(OMG_SOURCE_PROFILES.WEEKLY_GRID);
  const cycleRules = rulesForOmgmuSourceProfile(OMG_SOURCE_PROFILES.CYCLE_ROTATION_GRID);
  const combinedRules = rulesForOmgmuSourceProfile(OMG_SOURCE_PROFILES.COMBINED_ROTATION_TABLE);
  assert.ok(weeklyRules.includes("O01"));
  assert.ok(weeklyRules.includes("O65"));
  assert.ok(cycleRules.includes("O53"));
  assert.ok(combinedRules.includes("O69"));
  assert.ok(combinedRules.includes("O70"));
});
