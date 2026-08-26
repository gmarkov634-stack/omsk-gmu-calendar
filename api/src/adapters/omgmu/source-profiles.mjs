export const OMG_SOURCE_PROFILES = Object.freeze({
  WEEKLY_GRID: "weekly_grid",
  COURSE_LECTURE_LIST: "course_lecture_list",
  CYCLE_ROTATION_GRID: "cycle_rotation_grid",
  COMBINED_ROTATION_TABLE: "combined_rotation_table",
});

const COMMON_RULES = Object.freeze([
  "O01", "O02", "O05", "O06", "O08", "O09", "O10", "O11", "O12", "O15",
  "O17", "O18", "O25", "O28", "O32", "O33", "O34", "O38", "O45",
  "O46", "O48", "O50", "O54", "O55", "O56", "O64",
]);

const PROFILE_RULES = Object.freeze({
  [OMG_SOURCE_PROFILES.WEEKLY_GRID]: Object.freeze([
    "O03", "O04", "O13", "O14", "O16", "O22", "O27", "O57", "O58", "O59", "O60", "O61", "O62", "O63", "O65",
  ]),
  [OMG_SOURCE_PROFILES.COURSE_LECTURE_LIST]: Object.freeze([
    "O24", "O27", "O31", "O58", "O61", "O66", "O67", "O68", "O71", "O72",
  ]),
  [OMG_SOURCE_PROFILES.CYCLE_ROTATION_GRID]: Object.freeze([
    "O07", "O16", "O19", "O20", "O21", "O22", "O23", "O26", "O29", "O30", "O35",
    "O36", "O37", "O39", "O40", "O41", "O42", "O43", "O44", "O47", "O49",
    "O51", "O52", "O53",
  ]),
  [OMG_SOURCE_PROFILES.COMBINED_ROTATION_TABLE]: Object.freeze([
    "O07", "O20", "O21", "O22", "O26", "O29", "O30", "O37", "O42", "O43",
    "O44", "O49", "O52", "O69", "O70",
  ]),
});

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

export function rulesForOmgmuSourceProfile(profile) {
  const scoped = PROFILE_RULES[profile];
  if (!scoped) throw new Error(`Unsupported ОмГМУ source profile: ${profile}`);
  return uniqueSorted([...COMMON_RULES, ...scoped]);
}

function countUniqueWeekdays(text) {
  const aliases = [
    ["monday", "понедельник"],
    ["tuesday", "вторник"],
    ["wednesday", "среда"],
    ["thursday", "четверг"],
    ["friday", "пятница"],
    ["saturday", "суббота"],
  ];
  const value = String(text || "").toLowerCase();
  return aliases.filter((names) => names.some((name) => new RegExp(`(^|\\n)\\s*${name}\\s*(?:\\n|$)`, "m").test(value))).length;
}

function groupHeaderEvidence(text) {
  let maxCount = 0;
  let line = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    if (/\d{1,2}[.:]\d{2}/.test(rawLine)) continue;
    const codes = [...rawLine.matchAll(/(?<!\d)(\d{3,4})(?!\d)/g)]
      .map((match) => match[1])
      .filter((code) => !["2025", "2026"].includes(code));
    const count = new Set(codes).size;
    if (count > maxCount) {
      maxCount = count;
      line = rawLine.trim();
    }
  }
  return { maxCount, line };
}

function countMatches(text, expression) {
  return [...String(text || "").matchAll(expression)].length;
}

export function detectOmgmuSourceProfile(text, { filename = null } = {}) {
  const value = String(text || "");
  const lower = value.toLowerCase();
  const weekdayCount = countUniqueWeekdays(value);
  const groupHeader = groupHeaderEvidence(value);
  const cycleHeaderCount = countMatches(lower, /(?:^|\n)\s*\d+\s*(?:cycle|цикл)\s*:/gim);
  const lectureSection = /(?:^|\n)\s*(?:lectures|лекции)\s*(?:\n|$)/im.test(value);
  const dayCountColumn = /\bN\.\s*of\s*d\.?\b|К\.\s*дн\.?/i.test(value);
  const explicitLectureRows = countMatches(lower, /\(\s*(?:lectures|лекции)\s*\)/gim);
  const explicitCycleRows = countMatches(lower, /\(\s*(?:cycles|циклы)\s*\)/gim);
  const auditoriumEnvelope = /auditorium\s+classes|аудиторн\w*\s+занят/i.test(value);

  const candidates = [];
  if (weekdayCount >= 3 && groupHeader.maxCount >= 2 && cycleHeaderCount === 0) {
    candidates.push(OMG_SOURCE_PROFILES.WEEKLY_GRID);
  }
  if (lectureSection && weekdayCount >= 3 && groupHeader.maxCount < 2 && cycleHeaderCount === 0) {
    candidates.push(OMG_SOURCE_PROFILES.COURSE_LECTURE_LIST);
  }
  if (cycleHeaderCount >= 1 && dayCountColumn && groupHeader.maxCount >= 2) {
    candidates.push(OMG_SOURCE_PROFILES.CYCLE_ROTATION_GRID);
  }
  if (
    cycleHeaderCount === 0 &&
    dayCountColumn &&
    groupHeader.maxCount === 1 &&
    explicitLectureRows >= 1 &&
    explicitCycleRows >= 1 &&
    auditoriumEnvelope
  ) {
    candidates.push(OMG_SOURCE_PROFILES.COMBINED_ROTATION_TABLE);
  }

  const profile = candidates.length === 1 ? candidates[0] : null;
  const status = profile ? "classified" : "needs_review";
  return {
    filename,
    status,
    profile,
    candidates,
    applicableRules: profile ? rulesForOmgmuSourceProfile(profile) : [],
    evidence: {
      weekdayCount,
      groupHeaderCount: groupHeader.maxCount,
      groupHeaderLine: groupHeader.line || null,
      cycleHeaderCount,
      lectureSection,
      dayCountColumn,
      explicitLectureRows,
      explicitCycleRows,
      auditoriumEnvelope,
    },
  };
}

export function assertOmgmuSourceProfile(text, expectedProfile, context = {}) {
  const result = detectOmgmuSourceProfile(text, context);
  if (result.status !== "classified" || result.profile !== expectedProfile) {
    const source = context.filename ? ` ${context.filename}` : "";
    throw new Error(
      `ОмГМУ source profile mismatch${source}: expected ${expectedProfile}, detected ${result.profile || "needs_review"}; evidence=${JSON.stringify(result.evidence)}`,
    );
  }
  return result;
}

export const omgmuSourceProfileRegistry = Object.freeze({
  profiles: Object.freeze(Object.values(OMG_SOURCE_PROFILES)),
  commonRules: COMMON_RULES,
  profileRules: PROFILE_RULES,
});
