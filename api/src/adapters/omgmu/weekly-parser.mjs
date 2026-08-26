const DAYS = {
  понедельник: 1,
  вторник: 2,
  среда: 3,
  четверг: 4,
  пятница: 5,
  суббота: 6,
};

const HOLIDAYS_2026 = new Set(["2026-05-01", "2026-05-09", "2026-06-12"]);
const TIME_PATTERN = /(\d{1,2})[.:](\d{2})\s*-\s*(\d{1,2})[.:](\d{2})/;
const DATE_PATTERN = /(\d{2})\.(\d{2})\s*-\s*(\d{2})\.(\d{2})/;
const DATE_SINGLE_PATTERN = /(?<!\d)(\d{2})\.(\d{2})(?!\d)/;
const ALLOWED_MINUTES = new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function validCalendarPart(day, month) {
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

function datesForWeekday(start, end, weekday, year = 2026) {
  const result = [];
  const cursor = new Date(Date.UTC(year, start.month - 1, start.day));
  const last = new Date(Date.UTC(year, end.month - 1, end.day));
  while (cursor <= last) {
    const value = isoDate(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate());
    if (cursor.getUTCDay() === weekday && !HOLIDAYS_2026.has(value)) result.push(value);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function findDateRange(value) {
  for (const match of String(value || "").matchAll(new RegExp(DATE_PATTERN.source, "g"))) {
    const startDay = Number(match[1]);
    const startMonth = Number(match[2]);
    const endDay = Number(match[3]);
    const endMonth = Number(match[4]);
    if (!validCalendarPart(startDay, startMonth) || !validCalendarPart(endDay, endMonth)) continue;
    return { match, startDay, startMonth, endDay, endMonth };
  }
  return null;
}

function explicitDates(text, weekday, year = 2026) {
  const range = findDateRange(text);
  if (range) {
    return datesForWeekday(
      { day: range.startDay, month: range.startMonth },
      { day: range.endDay, month: range.endMonth },
      weekday,
      year,
    );
  }
  return [...String(text).matchAll(new RegExp(DATE_SINGLE_PATTERN.source, "g"))]
    .map((match) => ({ day: Number(match[1]), month: Number(match[2]) }))
    .filter((part) => validCalendarPart(part.day, part.month))
    .map((part) => isoDate(year, part.month, part.day))
    .filter((value) => !HOLIDAYS_2026.has(value));
}

function hasDateExpression(text) {
  if (findDateRange(text)) return true;
  return [...String(text).matchAll(new RegExp(DATE_SINGLE_PATTERN.source, "g"))]
    .some((match) => validCalendarPart(Number(match[1]), Number(match[2])));
}

function russianSection(text) {
  const marker = "РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ";
  const index = String(text || "").lastIndexOf(marker);
  return index >= 0 ? String(text).slice(index) : String(text || "");
}

function findTimeRange(value) {
  for (const match of String(value || "").matchAll(new RegExp(TIME_PATTERN.source, "g"))) {
    const startHour = Number(match[1]);
    const startMinute = Number(match[2]);
    const endHour = Number(match[3]);
    const endMinute = Number(match[4]);
    if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) continue;
    if (!ALLOWED_MINUTES.has(startMinute) || !ALLOWED_MINUTES.has(endMinute)) continue;
    const duration = endHour * 60 + endMinute - (startHour * 60 + startMinute);
    if (duration <= 0 || duration > 300) continue;
    return { match, startHour, startMinute, endHour, endMinute };
  }
  return null;
}

function stableHash(value) {
  let hash = 5381;
  for (const character of String(value)) hash = ((hash << 5) + hash) ^ character.charCodeAt(0);
  return (hash >>> 0).toString(36);
}

export function detectGroupColumns(text) {
  const lines = russianSection(text).split(/\r?\n/);
  let best = [];
  let bestLineLength = 0;

  for (const line of lines) {
    const matches = [...line.matchAll(/(?<!\d)(\d{3,4})(?!\d)/g)]
      .filter((match) => !["2025", "2026"].includes(match[1]));
    if (matches.length > best.length) {
      best = matches;
      bestLineLength = line.length;
    }
  }

  if (best.length < 2) return [];
  const centers = best.map((match) => match.index + match[1].length / 2);
  return best.map((match, index) => ({
    code: match[1],
    start: Math.max(0, Math.floor(index === 0 ? centers[0] - (centers[1] - centers[0]) / 2 : (centers[index - 1] + centers[index]) / 2)),
    end: Math.ceil(index === best.length - 1 ? Math.max(bestLineLength + 60, centers[index] + (centers[index] - centers[index - 1]) / 2) : (centers[index] + centers[index + 1]) / 2),
  }));
}

function cleanTitle(value, timeText, dateText) {
  return value
    .replace(timeText, " ")
    .replace(dateText || "", " ")
    .replace(/\b\d+\s*(?:зан\.|з\.|лекц(?:ий|ии)?|cl\.)\s*:?/gi, " ")
    .replace(/\b(?:ауд\.|корпус|здание)\b.*$/i, " ")
    .replace(/[,:;]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCell(buffer, { groupCode, weekday, course, stream }) {
  const text = buffer.join(" ").replace(/\s+/g, " ").trim();
  const time = findTimeRange(text);
  const dateRange = findDateRange(text);
  if (!time || !weekday) return [];
  const dates = explicitDates(text, weekday);
  if (!dates.length) return [];
  const title = cleanTitle(text, time.match[0], dateRange?.match?.[0]);
  if (!title || /^\d/.test(title)) return [];
  const startTime = `${String(time.startHour).padStart(2, "0")}:${String(time.startMinute).padStart(2, "0")}`;
  const endTime = `${String(time.endHour).padStart(2, "0")}:${String(time.endMinute).padStart(2, "0")}`;
  const titleHash = stableHash(title);
  return dates.map((date) => ({
    id: `omgmu-${groupCode}-${date}-${startTime.replace(":", "")}-${titleHash}`,
    title,
    start: `${date}T${startTime}:00+06:00`,
    end: `${date}T${endTime}:00+06:00`,
    location: "",
    sourceType: "weekly-table",
    course,
    stream,
  }));
}

export function parseWeeklyTable(text, { course, stream = null } = {}) {
  const section = russianSection(text).replace(/\f/g, "\n");
  const columns = detectGroupColumns(section);
  const byGroup = Object.fromEntries(columns.map((column) => [column.code, []]));
  const buffers = Object.fromEntries(columns.map((column) => [column.code, []]));
  let weekday = null;

  const flush = (code) => {
    if (!buffers[code].length) return;
    byGroup[code].push(...parseCell(buffers[code], { groupCode: code, weekday, course, stream }));
    buffers[code] = [];
  };

  for (const rawLine of section.split(/\r?\n/)) {
    const normalized = rawLine.toLowerCase().trim();
    const dayName = Object.keys(DAYS).find((day) => normalized.includes(day));
    if (dayName) {
      for (const code of Object.keys(buffers)) flush(code);
      weekday = DAYS[dayName];
      continue;
    }
    if (!weekday || !rawLine.trim()) continue;

    for (const column of columns) {
      const cell = rawLine.slice(column.start, column.end).trim();
      if (!cell) continue;
      if (findTimeRange(cell) && buffers[column.code].some((line) => findTimeRange(line))) flush(column.code);
      buffers[column.code].push(cell);
      if (hasDateExpression(cell) && findTimeRange(buffers[column.code].join(" "))) flush(column.code);
    }
  }
  for (const code of Object.keys(buffers)) flush(code);
  return byGroup;
}

export function buildWeeklySchedules(text, { course, stream = null, sourceUrl = null } = {}) {
  const parsed = parseWeeklyTable(text, { course, stream });
  return Object.entries(parsed).map(([code, events]) => ({
    version: 1,
    university: "omgmu",
    universityName: "ОмГМУ",
    program: "medicine-international",
    course,
    stream,
    academicYear: "2025-2026",
    semester: 2,
    timezone: "Asia/Omsk",
    group: {
      id: `omgmu:medicine-international:${course}:${stream ? `stream-${stream}:` : ""}${code}`,
      code,
      displayName: `Группа ${code}`,
    },
    sources: sourceUrl ? [{ url: sourceUrl, part: "combined" }] : [],
    events,
  }));
}
