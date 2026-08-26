import { buildOmgmuCanonicalBatch } from "./canonical.mjs";

const RANGE_RE = /(\d{2})\.(\d{2})\s*[-–]\s*(\d{2})\.(\d{2})/;
const TYPE_RE = /\((лекции|циклы)\)/i;
const CONTROL_RE = /зач[её]т\s*[-–]\s*(\d{2})\.(\d{2})(?:\s*[-–]\s*с\s*(\d{1,2})[.:](\d{2})\s*[-–]\s*(\d{1,2})[.:](\d{2}))?/i;

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCellText(value) {
  return compact(value)
    .replace(/з\s*а\s*ч\s*[её]\s*т/gi, "зачет")
    .replace(/\s*\.\s*/g, ".")
    .replace(/(?<=\d)\s+(?=\d)/g, "")
    .replace(/\s*[-–]\s*/g, "-")
    .replace(/,\s*/g, ", ")
    .trim();
}

function iso(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function checkedDate(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    throw new TypeError(`Invalid source date ${day}.${month}.${year}`);
  }
  return value;
}

function parseRange(text) {
  const match = String(text || "").match(RANGE_RE);
  if (!match) return null;
  return {
    raw: match[0],
    startDay: Number(match[1]),
    startMonth: Number(match[2]),
    endDay: Number(match[3]),
    endMonth: Number(match[4]),
  };
}

function parseTime(text) {
  const values = [...String(text || "").matchAll(/(\d{1,2})[.:](\d{2})/g)]
    .map((match) => `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`);
  if (values.length !== 2 || values[0] >= values[1]) return null;
  return { startTime: values[0], endTime: values[1] };
}

function parseControl(text, year) {
  const match = String(text || "").match(CONTROL_RE);
  if (!match) return null;
  checkedDate(year, Number(match[2]), Number(match[1]));
  return {
    date: iso(year, Number(match[2]), Number(match[1])),
    explicitTime: match[3]
      ? {
          startTime: `${String(Number(match[3])).padStart(2, "0")}:${match[4]}`,
          endTime: `${String(Number(match[5])).padStart(2, "0")}:${match[6]}`,
        }
      : null,
  };
}

function expandWorkingRange(range, { year, calendarExceptions }) {
  const start = checkedDate(year, range.startMonth, range.startDay);
  const end = checkedDate(year, range.endMonth, range.endDay);
  if (end < start) throw new TypeError(`Reversed combined range: ${range.raw}`);
  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const weekday = cursor.getUTCDay();
    const date = cursor.toISOString().slice(0, 10);
    if (weekday !== 0 && weekday !== 6 && !calendarExceptions.has(date)) dates.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function parseEnvelope(envelope, year) {
  const range = parseRange(`${envelope.start}-${envelope.end}`);
  if (!range) return null;
  return {
    start: iso(year, range.startMonth, range.startDay),
    end: iso(year, range.endMonth, range.endDay),
  };
}

function reference(page, row) {
  const bbox = row.groupBbox.map((value) => Number(value).toFixed(2)).join(",");
  return `pdf:p${page.pageNumber}:combined:row-${row.rowIndex}:bbox-${bbox}:group-${row.groupCode}`;
}

function ruleIds({ page, row, kind, control, controlAfterRangeBeforeType, controlSameMainDate }) {
  const rules = ["O07", "O20", "O21", "O26", "O43", "O44", "O49", "O52", "O64"];
  if (!row.disciplineInherited) rules.splice(rules.indexOf("O26"), 1);
  if (page.schemaInherited) rules.push("O69");
  if (control) rules.push("O30", "O42");
  if (control?.explicitTime) rules.push("O37");
  if (controlAfterRangeBeforeType) rules.push("O70");
  if (controlSameMainDate && !control.explicitTime) rules.push("O29");
  if (kind === "lecture" || kind === "cycle") rules.push("O44");
  return [...new Set(rules)];
}

function parseRow(page, row, geometry, options) {
  const text = normalizeCellText(row.groupText);
  const range = parseRange(text);
  const time = parseTime(row.timeText);
  const typeMatch = text.match(TYPE_RE);
  if (!range || !time || !typeMatch) return null;

  const kind = typeMatch[1].toLowerCase() === "лекции" ? "lecture" : "cycle";
  const control = parseControl(text, options.year);
  const mainDates = expandWorkingRange(range, options);
  const controlSameMainDate = Boolean(control && mainDates.includes(control.date));
  const typeIndex = typeMatch.index ?? text.length;
  const controlIndex = control ? text.search(CONTROL_RE) : -1;
  const rangeIndex = text.search(RANGE_RE);
  const controlAfterRangeBeforeType = Boolean(control && rangeIndex >= 0 && controlIndex > rangeIndex && controlIndex < typeIndex);
  const uniqueDates = new Set(mainDates);
  if (control) uniqueDates.add(control.date);
  const warnings = [];

  if (uniqueDates.size !== row.declaredDays) {
    warnings.push(`O20/O30: К.дн.=${row.declaredDays}, resolved unique education/control dates=${uniqueDates.size}`);
  }
  const envelope = parseEnvelope(geometry.localEnvelope, options.year);
  if (envelope && mainDates.some((date) => date < envelope.start || date > envelope.end)) {
    warnings.push(`O55: series range ${range.raw} leaves local envelope ${geometry.localEnvelope.start}-${geometry.localEnvelope.end}`);
  }
  if (control && envelope && (control.date < envelope.start || control.date > envelope.end)) {
    warnings.push(`O55: control ${control.date} leaves local envelope ${geometry.localEnvelope.start}-${geometry.localEnvelope.end}`);
  }

  return {
    discipline: row.discipline,
    disciplineRaw: row.discipline,
    disciplineNormalized: row.discipline,
    group: row.groupCode,
    kind,
    typeRaw: kind === "lecture" ? "лекции" : "циклы",
    startTime: time.startTime,
    endTime: time.endTime,
    mainRange: range.raw,
    mainDates,
    control,
    declaredDays: row.declaredDays,
    status: warnings.length ? "needs_review" : "ok",
    warnings,
    ruleIds: ruleIds({ page, row, kind, control, controlAfterRangeBeforeType, controlSameMainDate }),
    rawSource: `${row.discipline} | ${row.timeText} | К.дн. ${row.declaredDays} | ${text}`,
    references: [{ role: "lesson", range: reference(page, row) }],
    geometry: {
      pageNumber: page.pageNumber,
      rowIndex: row.rowIndex,
      groupBbox: [...row.groupBbox],
      schemaInherited: page.schemaInherited,
      schemaFromPage: page.schemaFromPage,
    },
    o70Composite: controlAfterRangeBeforeType,
  };
}

function materializeRecord(record) {
  const mainDates = [...record.mainDates];
  const sameDateControl = record.control && mainDates.includes(record.control.date) && !record.control.explicitTime;
  const normalDates = sameDateControl ? mainDates.filter((date) => date !== record.control.date) : mainDates;
  const result = [];

  if (normalDates.length) {
    result.push({
      discipline: record.discipline,
      disciplineRaw: record.disciplineRaw,
      disciplineNormalized: record.disciplineNormalized,
      startTime: record.startTime,
      endTime: record.endTime,
      dates: normalDates,
      kind: record.kind,
      typeRaw: record.typeRaw,
      groups: [record.group],
      location: "",
      sourceNote: null,
      status: record.status,
      warnings: [...record.warnings],
      ruleIds: [...record.ruleIds],
      rawSource: record.rawSource,
      references: record.references.map((item) => ({ ...item })),
    });
  }

  if (record.control) {
    const controlTime = record.control.explicitTime || {
      startTime: record.startTime,
      endTime: record.endTime,
    };
    result.push({
      discipline: record.discipline,
      disciplineRaw: record.disciplineRaw,
      disciplineNormalized: record.disciplineNormalized,
      startTime: controlTime.startTime,
      endTime: controlTime.endTime,
      dates: [record.control.date],
      kind: "credit",
      typeRaw: "зачет",
      groups: [record.group],
      location: "",
      sourceNote: null,
      status: record.status,
      warnings: [...record.warnings],
      ruleIds: [...record.ruleIds],
      rawSource: record.rawSource,
      references: record.references.map((item) => ({ ...item })),
    });
  }

  return result;
}

export function parseCombinedRotationGeometry(geometry, { year, calendarExceptions = [] } = {}) {
  if (geometry?.version !== 1 || geometry?.sourceProfile !== "combined_rotation_table") {
    throw new TypeError("combined_rotation_table geometry/v1 is required");
  }
  if (geometry?.sourceLanguage !== "ru") {
    const error = new Error("combined_rotation_table production geometry must come from Russian source_part");
    error.code = "OMG_COMBINED_ROTATION_RU_REQUIRED";
    throw error;
  }
  if (!Number.isInteger(Number(year))) throw new TypeError("combined_rotation_table requires explicit calendar year");
  if (!geometry?.columnSchema?.groupCode) throw new TypeError("combined_rotation_table requires proven columnSchema");

  const options = { year: Number(year), calendarExceptions: new Set(calendarExceptions.map(String)) };
  const sourceSeries = [];
  const diagnostics = [];
  for (const page of geometry.pages || []) {
    if (page.schemaInherited && page.schemaFromPage == null) {
      diagnostics.push(`page ${page.pageNumber}: inherited schema has no source page`);
      continue;
    }
    for (const row of page.rows || []) {
      const record = parseRow(page, row, geometry, options);
      if (record) sourceSeries.push(record);
      else diagnostics.push(`page ${page.pageNumber} row ${row.rowIndex}: unresolved combined row`);
    }
  }

  return {
    group: String(geometry.columnSchema.groupCode),
    sourceSeries,
    diagnostics,
  };
}

function calendarYear(metadata) {
  const start = String(metadata?.period?.start_date ?? metadata?.period?.startDate ?? "").match(/^(20\d{2})-/);
  if (!start) throw new TypeError("combined_rotation_table metadata.period.start_date is required");
  return Number(start[1]);
}

export function buildCombinedRotationCanonicalCandidate(geometry, { metadata, source } = {}) {
  const group = String(metadata?.groupCode ?? metadata?.group ?? "").trim();
  if (!group) throw new TypeError("combined_rotation_table metadata.group is required");

  const parsed = parseCombinedRotationGeometry(geometry, {
    year: calendarYear(metadata),
    calendarExceptions: metadata?.calendarExceptions || [],
  });
  if (parsed.group !== group) {
    const error = new Error(`combined_rotation_table geometry contains group ${parsed.group}, requested ${group}`);
    error.code = "OMG_COMBINED_ROTATION_GROUP_NOT_FOUND";
    throw error;
  }
  if (parsed.diagnostics.length) {
    const error = new Error(`combined_rotation_table has ${parsed.diagnostics.length} unresolved diagnostic(s)`);
    error.code = "OMG_COMBINED_ROTATION_NEEDS_REVIEW";
    error.diagnostics = parsed.diagnostics;
    throw error;
  }
  if (!parsed.sourceSeries.length) {
    const error = new Error("combined_rotation_table produced no source series");
    error.code = "OMG_COMBINED_ROTATION_EMPTY";
    throw error;
  }

  const userSeries = parsed.sourceSeries.flatMap(materializeRecord).map((series) => ({
    ...series,
    jointGroups: [],
  }));
  const batch = buildOmgmuCanonicalBatch({
    metadata: {
      ...metadata,
      parser: metadata?.parser || "omgmu-combined-rotation-table/o01-o72",
    },
    source,
    series: userSeries,
  });

  return { batch, sourceSeries: parsed.sourceSeries, userSeries, group };
}

export function buildCombinedRotationCanonicalBatch(geometry, options = {}) {
  return buildCombinedRotationCanonicalCandidate(geometry, options).batch;
}

export const combinedRotationInternals = Object.freeze({
  normalizeCellText,
  parseRange,
  parseTime,
  parseControl,
  materializeRecord,
});
