const DAYS = { понедельник: 1, вторник: 2, среда: 3, четверг: 4, пятница: 5, суббота: 6 };
const HOLIDAYS = new Set(["2026-05-01", "2026-05-09", "2026-06-12"]);
const TIME_RE = /(\d{1,2})[.:](\d{2})\s*-\s*(\d{1,2})[.:](\d{2})/g;
const DATE_RE = /(\d{2})\.(\d{2})\s*-\s*(\d{2})\.(\d{2})/g;
const SINGLE_DATE_RE = /(?<!\d)(\d{2})\.(\d{2})(?!\d)/g;
const PARTIAL_TIME_RE = /(?:^|\s)(?:с\s*)?\d{1,2}[.:]\d{2}\s*[-–]\s*\d{1,2}(?:[.:]\d{0,2})?/gi;

function section(text) {
  const value = String(text || "").replace(/\f/g, "\n");
  const index = value.lastIndexOf("РАСПИСАНИЕ УЧЕБНЫХ ЗАНЯТИЙ");
  return index >= 0 ? value.slice(index) : value;
}

function validDatePart(day, month) {
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

function validSemesterDatePart(day, month) {
  return validDatePart(day, month) && month <= 8;
}

function validTimeMatch(match) {
  const sh = Number(match[1]); const sm = Number(match[2]);
  const eh = Number(match[3]); const em = Number(match[4]);
  const duration = eh * 60 + em - (sh * 60 + sm);
  return sh <= 23 && eh <= 23 && sm <= 59 && em <= 59 && duration > 0 && duration <= 300;
}

function findTimes(value) {
  return [...String(value).matchAll(TIME_RE)]
    .filter(validTimeMatch)
    .map((match) => ({
      match,
      sh: Number(match[1]),
      sm: Number(match[2]),
      eh: Number(match[3]),
      em: Number(match[4]),
    }));
}

function findTime(value) {
  return findTimes(value)[0] || null;
}

function findDateRange(value) {
  for (const match of String(value).matchAll(DATE_RE)) {
    const sd = Number(match[1]); const sm = Number(match[2]);
    const ed = Number(match[3]); const em = Number(match[4]);
    if (validSemesterDatePart(sd, sm) && validSemesterDatePart(ed, em)) return { match, sd, sm, ed, em };
  }
  return null;
}

function iso(month, day) {
  return `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function protectedSpans(value) {
  const text = String(value);
  return [...text.matchAll(TIME_RE), ...text.matchAll(DATE_RE)]
    .map((match) => [match.index, match.index + match[0].length]);
}

function overlapsProtected(match, spans) {
  const start = match.index;
  const end = start + match[0].length;
  return spans.some(([spanStart, spanEnd]) => start < spanEnd && end > spanStart);
}

function eventDates(text, weekday) {
  const range = findDateRange(text);
  if (range) {
    const result = [];
    const cursor = new Date(Date.UTC(2026, range.sm - 1, range.sd));
    const end = new Date(Date.UTC(2026, range.em - 1, range.ed));
    while (cursor <= end) {
      const value = cursor.toISOString().slice(0, 10);
      if (cursor.getUTCDay() === weekday && !HOLIDAYS.has(value)) result.push(value);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return result;
  }

  const value = String(text);
  const spans = protectedSpans(value);
  return [...value.matchAll(SINGLE_DATE_RE)]
    .filter((match) => !overlapsProtected(match, spans))
    .map((match) => ({ day: Number(match[1]), month: Number(match[2]) }))
    .filter((part) => validSemesterDatePart(part.day, part.month))
    .map((part) => iso(part.month, part.day))
    .filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === weekday)
    .filter((date) => !HOLIDAYS.has(date));
}

function hash(value) {
  let result = 5381;
  for (const char of String(value)) result = ((result << 5) + result) ^ char.charCodeAt(0);
  return (result >>> 0).toString(36);
}

function deduplicateEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = [event.start, event.end, event.title, event.location || ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function detectGroupColumns(text) {
  let best = [];
  let width = 0;
  for (const line of section(text).split(/\r?\n/)) {
    const matches = [...line.matchAll(/(?<!\d)(\d{3,4})(?!\d)/g)].filter((m) => !["2025", "2026"].includes(m[1]));
    if (matches.length > best.length) { best = matches; width = line.length; }
  }
  if (best.length < 2) return [];
  const centers = best.map((m) => m.index + m[1].length / 2);
  return best.map((m, index) => ({
    code: m[1],
    start: Math.max(0, Math.floor(index ? (centers[index - 1] + centers[index]) / 2 : centers[0] - (centers[1] - centers[0]) / 2)),
    end: Math.ceil(index === best.length - 1 ? Math.max(width + 80, centers[index] + (centers[index] - centers[index - 1]) / 2) : (centers[index] + centers[index + 1]) / 2),
  }));
}

function dayBlocks(lines) {
  const markers = [];
  lines.forEach((line, index) => {
    const normalized = line.toLowerCase();
    const name = Object.keys(DAYS).find((day) => normalized.includes(day));
    if (name) markers.push({ index, weekday: DAYS[name] });
  });
  return markers.map((marker, index) => ({
    weekday: marker.weekday,
    start: index === 0 ? Math.max(0, marker.index - Math.floor((markers[index + 1]?.index - marker.index || 20) / 2)) : Math.floor((markers[index - 1].index + marker.index) / 2),
    end: index === markers.length - 1 ? lines.length : Math.floor((marker.index + markers[index + 1].index) / 2),
  }));
}

function stripSingleDates(value) {
  return String(value).replace(SINGLE_DATE_RE, (full, day, month) => (
    validSemesterDatePart(Number(day), Number(month)) ? " " : full
  ));
}

function cleanTitle(text, timeText, dateText) {
  let value = String(text).replace(timeText, " ").replace(dateText || "", " ");
  value = value.replace(TIME_RE, " ").replace(DATE_RE, " ");
  value = stripSingleDates(value).replace(PARTIAL_TIME_RE, " ");
  return value
    .replace(/^\s*с\s+/i, " ")
    .replace(/\b\d+\s*(?:зан\.|з\.|лекц(?:ий|ии)?|cl\.)\s*:?/gi, " ")
    .replace(/\b(?:ауд\.|корпус|здание)\b.*$/i, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/[,:;]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseChunk(lines, groupCode, weekday, course, stream) {
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  const times = findTimes(text);
  const range = findDateRange(text);
  if (times.length !== 1) return [];
  const time = times[0];
  const dates = eventDates(text, weekday);
  const title = cleanTitle(text, time.match[0], range?.match?.[0]);
  if (!dates.length || !title || /^\d/.test(title)) return [];
  const start = `${String(time.sh).padStart(2, "0")}:${String(time.sm).padStart(2, "0")}`;
  const end = `${String(time.eh).padStart(2, "0")}:${String(time.em).padStart(2, "0")}`;
  const suffix = hash(title);
  return dates.map((date) => ({
    id: `omgmu-${groupCode}-${date}-${start.replace(":", "")}-${suffix}`,
    title,
    start: `${date}T${start}:00+06:00`,
    end: `${date}T${end}:00+06:00`,
    location: "",
    sourceType: "weekly-table",
    course,
    stream,
  }));
}

function parseColumn(lines, column, weekday, course, stream) {
  const chunks = [];
  let current = [];
  for (const line of lines) {
    const cell = line.slice(column.start, column.end).trim();
    if (!cell) continue;
    if (findTime(cell) && current.some((part) => findTime(part))) {
      chunks.push(current); current = [];
    }
    current.push(cell);
    if (findDateRange(cell) && current.some((part) => findTime(part))) {
      chunks.push(current); current = [];
    }
  }
  if (current.length) chunks.push(current);
  return chunks.flatMap((chunk) => parseChunk(chunk, column.code, weekday, course, stream));
}

export function parseWeeklyTable(text, { course, stream = null } = {}) {
  const value = section(text);
  const lines = value.split(/\r?\n/);
  const columns = detectGroupColumns(value);
  const result = Object.fromEntries(columns.map((column) => [column.code, []]));
  for (const block of dayBlocks(lines)) {
    const blockLines = lines.slice(block.start, block.end);
    for (const column of columns) result[column.code].push(...parseColumn(blockLines, column, block.weekday, course, stream));
  }
  for (const code of Object.keys(result)) result[code] = deduplicateEvents(result[code]);
  return result;
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
    group: { id: `omgmu:medicine-international:${course}:${stream ? `stream-${stream}:` : ""}${code}`, code, displayName: `Группа ${code}` },
    sources: sourceUrl ? [{ url: sourceUrl, part: "combined" }] : [],
    events,
  }));
}

export const weeklyParserInternals = Object.freeze({ eventDates, cleanTitle });
