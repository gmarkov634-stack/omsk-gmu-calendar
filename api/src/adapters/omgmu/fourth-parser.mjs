const HOLIDAYS_2026 = new Set(["2026-05-01", "2026-05-09", "2026-06-12"]);
const WEEKDAYS = { ПОНЕДЕЛЬНИК: 1, ВТОРНИК: 2, СРЕДА: 3, ЧЕТВЕРГ: 4, ПЯТНИЦА: 5 };
const LECTURE_DATE_ATOM = String.raw`\d{2}\.\d{2}(?:\s*[–-]\s*\d{2}\.\d{2})?`;
const LECTURE_DATE_LOCATION_RE = new RegExp(
  `^(${LECTURE_DATE_ATOM}(?:\\s*[,;]\\s*${LECTURE_DATE_ATOM})*(?:\\s*\\([^)]*\\))?)\\s*[–-]\\s*(.+)$`,
  "i",
);
const EXPLICIT_LECTURE_LOCATION_RE = /(?:БУЗОО|ФГБОУ|ФГБУ|(?:^|[^\p{L}\p{N}])(?:ауд\.?|ГК\.?|ул\.?)|стационар|корпус|здание)/iu;
const DATE_EXPRESSION_PREFIX_RE = new RegExp(
  `^${LECTURE_DATE_ATOM}(?:\\s*[,;]\\s*${LECTURE_DATE_ATOM})*(?:\\s*\\([^)]*\\))?`,
  "i",
);

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function stableHash(value) {
  let hash = 5381;
  for (const character of String(value)) hash = ((hash << 5) + hash) ^ character.charCodeAt(0);
  return (hash >>> 0).toString(36);
}

function rangeDates(start, end, { weekday = null, includeSaturday = false } = {}) {
  const dates = [];
  const cursor = new Date(Date.UTC(2026, start.month - 1, start.day));
  const last = new Date(Date.UTC(2026, end.month - 1, end.day));
  while (cursor <= last) {
    const day = cursor.getUTCDay();
    const value = isoDate(cursor);
    const allowedDay = weekday == null
      ? day !== 0 && (includeSaturday || day !== 6)
      : day === weekday;
    if (allowedDay && !HOLIDAYS_2026.has(value)) dates.push(value);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function parseDateExpression(value, weekday = null) {
  const normalized = value.replace(/зач[её]т[^,;]*/gi, "").replace(/с\s+\d{2}[.:]\d{2}[^,;]*/gi, "");
  const dates = [];
  for (const match of normalized.matchAll(/(\d{2})\.(\d{2})(?:\s*[–-]\s*(\d{2})\.(\d{2}))?/g)) {
    const start = { day: Number(match[1]), month: Number(match[2]) };
    const end = match[3] ? { day: Number(match[3]), month: Number(match[4]) } : start;
    dates.push(...rangeDates(start, end, { weekday }));
  }
  return [...new Set(dates)].sort();
}

function splitLectureDateAndLocation(value) {
  const normalized = String(value || "").trim();
  const match = normalized.match(LECTURE_DATE_LOCATION_RE);
  if (!match || !EXPLICIT_LECTURE_LOCATION_RE.test(match[2])) {
    return { dateExpression: normalized, location: "", usedLocationDelimiter: false };
  }
  return {
    dateExpression: match[1].trim(),
    location: match[2].trim(),
    usedLocationDelimiter: true,
  };
}

function hasAmbiguousLocationDelimiter(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return false;
  const fullMatch = normalized.match(LECTURE_DATE_LOCATION_RE);
  if (fullMatch && EXPLICIT_LECTURE_LOCATION_RE.test(fullMatch[2])) return false;
  const prefix = normalized.match(DATE_EXPRESSION_PREFIX_RE)?.[0]?.trim();
  if (!prefix || prefix.length >= normalized.length) return false;
  const tail = normalized.slice(prefix.length).trim();
  return /^[–-]\s*\S/.test(tail);
}

function russianSection(text, marker) {
  const index = String(text || "").lastIndexOf(marker);
  return index >= 0 ? String(text).slice(index) : "";
}

function lectureRuleIds({ current, dateExpression, location, usedLocationDelimiter }) {
  const rules = ["O24", "O27", "O64", "O68"];
  if (current.starred) rules.push("O31");
  else if (current.weekday != null) rules.push("O72");
  if (current.rawLines.length > 1) rules.push("O66");
  if (location) rules.push("O58");
  if (usedLocationDelimiter) rules.push("O67");
  if (/[;,]/.test(dateExpression)) rules.push("O61");
  return [...new Set(rules)];
}

function logicalBody(current) {
  return current.lines.join(" ").replace(/\s+/g, " ").trim();
}

function lectureCountMarker(value) {
  return String(value || "").match(/^(.+?),\s*(\d+)\s+лекц(?:ия|ии|ий):\s*(.+)$/i);
}

function isConfidentLectureContinuation(current, line) {
  const previous = logicalBody(current);
  const marker = lectureCountMarker(previous);
  const trimmed = String(line || "").trim();
  if (!trimmed) return true;
  if (!marker) return /\b\d+\s+лекц(?:ия|ии|ий):/i.test(trimmed) || /^\d{2}\.\d{2}/.test(trimmed);
  const split = splitLectureDateAndLocation(marker[3]);
  if (/^[–-]\s*/.test(trimmed) && EXPLICIT_LECTURE_LOCATION_RE.test(trimmed)) return true;
  if (/[–-]\s*$/.test(marker[3]) && EXPLICIT_LECTURE_LOCATION_RE.test(trimmed)) return true;
  if (split.location && EXPLICIT_LECTURE_LOCATION_RE.test(trimmed)) return true;
  if (/[,;]\s*$/.test(marker[3]) && /^\d{2}\.\d{2}/.test(trimmed)) return true;
  return false;
}

function markRecordNeedsReview(record, warning) {
  record.status = "needs_review";
  if (!record.warnings.includes(warning)) record.warnings.push(warning);
}

function applyLectureCollisionReview(records) {
  const byOccurrence = new Map();
  for (const record of records) {
    for (const date of record.dates) {
      const key = `${date}|${record.startTime}|${record.endTime}`;
      const bucket = byOccurrence.get(key) || [];
      bucket.push(record);
      byOccurrence.set(key, bucket);
    }
  }
  for (const [key, bucket] of byOccurrence) {
    const disciplines = new Set(bucket.map((record) => record.disciplineNormalized));
    if (disciplines.size <= 1) continue;
    const [date, startTime, endTime] = key.split("|");
    const warning = `O68: different disciplines overlap on ${date} ${startTime}-${endTime}`;
    for (const record of bucket) markRecordNeedsReview(record, warning);
  }
}

export function parseFourthCourseLectures(text) {
  const lines = russianSection(text, "РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ").split(/\r?\n/);
  let weekday = null;
  const records = [];
  let current = null;
  let lineNumber = 0;
  const flush = () => {
    if (!current) return;
    const countMarker = lectureCountMarker(logicalBody(current));
    if (countMarker) {
      const declaredCount = Number(countMarker[2]);
      const { dateExpression, location, usedLocationDelimiter } = splitLectureDateAndLocation(countMarker[3]);
      const ambiguousLocationDelimiter = !usedLocationDelimiter && hasAmbiguousLocationDelimiter(countMarker[3]);
      const dates = parseDateExpression(dateExpression, current.weekday);
      if (dates.length) {
        const warnings = [];
        let status = "ok";
        if (dates.length !== declaredCount) {
          status = "needs_review";
          warnings.push(`O27: declared ${declaredCount} lecture(s), resolved ${dates.length} date(s)`);
        }
        if (current.ambiguousContinuation) {
          status = "needs_review";
          warnings.push("O66: physical continuation is not unambiguously attached to the lecture record");
        }
        if (ambiguousLocationDelimiter) {
          if (status === "ok") status = "warning";
          warnings.push("O67: possible location delimiter is ambiguous; location was not inferred");
        }
        records.push({
          discipline: countMarker[1].trim(), disciplineRaw: countMarker[1].trim(), disciplineNormalized: countMarker[1].trim(),
          startTime: current.startTime, endTime: current.endTime, dates, dateExpression, declaredCount,
          structuralWeekday: current.weekday, location, kind: "lecture", typeRaw: "лекция",
          rawSource: current.rawLines.map((line) => line.trim()).join("\n"),
          references: [{ role: "lesson", range: `ru:lines:${current.startLine}-${current.endLine}` }],
          ruleIds: lectureRuleIds({ current, dateExpression, location, usedLocationDelimiter: usedLocationDelimiter || ambiguousLocationDelimiter }),
          status, warnings,
        });
      }
    }
    current = null;
  };
  for (const rawLine of lines) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (WEEKDAYS[line]) { flush(); weekday = WEEKDAYS[line]; continue; }
    const match = rawLine.match(/^\s*(\*)?(\d{2})[.:](\d{2})-(\d{2})[.:](\d{2})\s+(.+)$/);
    if (match) {
      flush();
      current = { startTime: `${match[2]}:${match[3]}`, endTime: `${match[4]}:${match[5]}`, starred: Boolean(match[1]), weekday: match[1] ? null : weekday, lines: [match[6]], rawLines: [rawLine.trimEnd()], startLine: lineNumber, endLine: lineNumber, ambiguousContinuation: false };
    } else if (current && line) {
      if (!isConfidentLectureContinuation(current, line)) current.ambiguousContinuation = true;
      current.lines.push(line); current.rawLines.push(rawLine.trimEnd()); current.endLine = lineNumber;
    }
  }
  flush();
  applyLectureCollisionReview(records);
  return records;
}

function blockDiscipline(lines) {
  return lines.map((line) => line.slice(0, 31).trim()).filter((value) => value && !/^(Дисциплина|\d+\s*цикл)/i.test(value)).join(" ").replace(/\s+/g, " ").trim();
}
function blockTimes(lines) {
  const values = [];
  for (const line of lines) for (const match of line.slice(27, 43).matchAll(/(\d{2})[.:](\d{2})/g)) values.push(`${match[1]}:${match[2]}`);
  return values.length >= 2 ? { startTime: values[0], endTime: values.at(-1) } : null;
}
function groupColumn(lines, groupCode) {
  const start = groupCode === "485" ? 43 : 78;
  const end = groupCode === "485" ? 78 : undefined;
  return lines.map((line) => line.slice(start, end).trim()).filter(Boolean).join(" ");
}
export function parseFourthCourseCycles(text) {
  const section = russianSection(text, "РАСПИСАНИЕ ЦИКЛОВЫХ ЗАНЯТИЙ").replace(/\f/g, "\n\n");
  const records = { "485": [], "486": [] };
  for (const block of section.split(/\n\s*\n+/)) {
    const lines = block.split(/\r?\n/); const discipline = blockDiscipline(lines); const times = blockTimes(lines);
    if (!discipline || !times || /Дисциплина|К\.дн/i.test(discipline)) continue;
    for (const groupCode of ["485", "486"]) {
      const column = groupColumn(lines, groupCode); const dates = parseDateExpression(column); if (!dates.length) continue;
      records[groupCode].push({ discipline, ...times, dates, kind: /лекц/i.test(column) ? "lecture" : "cycle", location: "" });
    }
  }
  return records;
}
function scheduleFor(groupCode, lectureRecords, cycleRecords, sources) {
  const records = [...lectureRecords, ...cycleRecords];
  const events = records.flatMap((record) => {
    const disciplineHash = stableHash(record.discipline);
    return record.dates.map((date) => ({ id: `omgmu-${groupCode}-${date}-${record.startTime.replace(":", "")}-${record.kind}-${disciplineHash}`, title: `${record.kind === "lecture" ? "Лекция" : "Цикл"}: ${record.discipline}`, start: `${date}T${record.startTime}:00+06:00`, end: `${date}T${record.endTime}:00+06:00`, location: record.location || "", sourceType: record.kind }));
  });
  events.sort((a, b) => a.start.localeCompare(b.start));
  return { version: 1, university: "omgmu", universityName: "ОмГМУ", program: "medicine-international", course: 4, stream: null, academicYear: "2025-2026", semester: 2, timezone: "Asia/Omsk", group: { id: `omgmu:medicine-international:4:${groupCode}`, code: groupCode, displayName: `Группа ${groupCode}` }, sources, events };
}
export function buildFourthCourseSchedules(lecturesText, cyclesText, { lectureUrl = null, cyclesUrl = null } = {}) {
  const lectures = parseFourthCourseLectures(lecturesText); const cycles = parseFourthCourseCycles(cyclesText);
  const sources = [lectureUrl ? { url: lectureUrl, part: "lectures" } : null, cyclesUrl ? { url: cyclesUrl, part: "cycles" } : null].filter(Boolean);
  return { "485": scheduleFor("485", lectures, cycles["485"], sources), "486": scheduleFor("486", lectures, cycles["486"], sources) };
}
