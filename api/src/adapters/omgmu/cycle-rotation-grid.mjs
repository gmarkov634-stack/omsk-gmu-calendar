import { buildOmgmuCanonicalBatch } from "./canonical.mjs";

const RANGE_RE = /(\d{2})\.(\d{2})\s*[-–]\s*(\d{2})\.(\d{2})/;
const CONTROL_RE = /зач[её]т\s*[-–]\s*(\d{2})\.(\d{2})(?:\s*[-–]\s*с\s*(\d{1,2})[.:](\d{2})\s*[-–]\s*(\d{1,2})[.:](\d{2}))?/i;
const TYPE_RE = /\((лекции|циклы)\)/i;

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

function dateValue(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    throw new TypeError(`Invalid source date ${day}.${month}.${year}`);
  }
  return value;
}

function normalizeExceptionDate(value, year) {
  const text = String(value || "").trim();
  const isoMatch = text.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const parsedYear = Number(isoMatch[1]);
    dateValue(parsedYear, Number(isoMatch[2]), Number(isoMatch[3]));
    return text;
  }
  const sourceMatch = text.match(/^(\d{2})\.(\d{2})$/);
  if (!sourceMatch) throw new TypeError(`Invalid calendar exception date: ${text}`);
  dateValue(year, Number(sourceMatch[2]), Number(sourceMatch[1]));
  return iso(year, Number(sourceMatch[2]), Number(sourceMatch[1]));
}

function normalizeConditionalExceptions(values, year) {
  if (!Array.isArray(values)) return [];
  return values.map((item) => {
    if (!item || typeof item !== "object") throw new TypeError("conditional calendar exception must be an object");
    const policy = String(item.policy || "").trim();
    if (policy !== "exclude_if_required_for_exact_control") {
      throw new TypeError(`Unsupported conditional calendar exception policy: ${policy || "<empty>"}`);
    }
    return {
      date: normalizeExceptionDate(item.date, year),
      policy,
      ruleIds: Array.isArray(item.rule_ids) ? item.rule_ids.map(String) : ["O32", "O34"],
      evidence: item.evidence || null,
      note: item.note ? String(item.note) : null,
    };
  });
}

function expandWorkingRange(range, { year, calendarExceptions }) {
  const start = dateValue(year, range.startMonth, range.startDay);
  const end = dateValue(year, range.endMonth, range.endDay);
  if (end < start) throw new TypeError(`Reversed cycle range: ${range.raw}`);
  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    // The cycle source explicitly says `без субботы`; Sunday is not treated as
    // a teaching day. O33 source holidays are unconditional. External
    // non-working days are NOT handled here: O32/O34 resolve them per series.
    if (weekday !== 0 && weekday !== 6 && !calendarExceptions.has(date)) dates.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
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

function parseControl(text, year) {
  const match = String(text || "").match(CONTROL_RE);
  if (!match) return null;
  const date = iso(year, Number(match[2]), Number(match[1]));
  dateValue(year, Number(match[2]), Number(match[1]));
  const explicitTime = match[3]
    ? {
        startTime: `${String(Number(match[3])).padStart(2, "0")}:${match[4]}`,
        endTime: `${String(Number(match[5])).padStart(2, "0")}:${match[6]}`,
      }
    : null;
  return { date, explicitTime };
}

function parseTimeSlots(text) {
  const values = [...String(text || "").matchAll(/(\d{1,2})[.:](\d{2})/g)]
    .map((match) => `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`);
  if (!values.length || values.length % 2 !== 0) return [];
  const slots = [];
  for (let index = 0; index < values.length; index += 2) {
    if (values[index] >= values[index + 1]) return [];
    slots.push({ startTime: values[index], endTime: values[index + 1] });
  }
  return slots;
}

function envelopeDates(envelope, year) {
  const range = parseRange(`${envelope.start}-${envelope.end}`);
  if (!range) return null;
  return {
    start: iso(year, range.startMonth, range.startDay),
    end: iso(year, range.endMonth, range.endDay),
  };
}

function reference(cycle, row, cell) {
  const bbox = cell.bbox.map((value) => Number(value).toFixed(2)).join(",");
  return `pdf:p${cycle.pageNumber}:cycle-${cycle.cycleNo}:row-${row.rowIndex}:bbox-${bbox}:groups-${cell.groups.join("+")}`;
}

function educationDateCount(mainDates, control) {
  const dates = new Set(mainDates);
  if (control) dates.add(control.date);
  return dates.size;
}

function resolveConditionalCalendarExceptions({ mainDates, control, declaredDays, candidates }) {
  const applicable = candidates.filter((candidate) => mainDates.includes(candidate.date));
  const baseCount = educationDateCount(mainDates, control);
  if (!applicable.length) {
    return {
      mainDates,
      baseCount,
      resolvedCount: baseCount,
      applied: [],
      kept: [],
      mode: "none",
    };
  }

  // O32: a more specific official OmGMU row wins when it is already internally
  // consistent. External non-working days may not erase such an event.
  if (baseCount === declaredDays) {
    return {
      mainDates,
      baseCount,
      resolvedCount: baseCount,
      applied: [],
      kept: applicable,
      mode: "source_priority_keep",
    };
  }

  // O34: external dates are candidates, not global exclusions. Apply the full
  // independently-authoritative candidate set only when it uniquely resolves
  // this exact series to its explicit control count. Never choose an arbitrary
  // subset merely to make arithmetic fit.
  const applicableDates = new Set(applicable.map((candidate) => candidate.date));
  const withoutCandidates = mainDates.filter((date) => !applicableDates.has(date));
  const candidateCount = educationDateCount(withoutCandidates, control);
  if (candidateCount === declaredDays) {
    return {
      mainDates: withoutCandidates,
      baseCount,
      resolvedCount: candidateCount,
      applied: applicable,
      kept: [],
      mode: "external_exception_applied",
    };
  }

  return {
    mainDates,
    baseCount,
    resolvedCount: baseCount,
    applied: [],
    kept: applicable,
    mode: "unresolved",
  };
}

function recordRuleIds({ cycle, row, cell, kind, typeExplicit, slots, control, controlSameMainDate, hasSourceExceptions, calendarResolution }) {
  const rules = ["O07", "O16", "O20", "O22", "O23", "O35", "O39", "O43", "O49", "O64"];
  if (cycle.envelope.withoutSaturday) rules.push("O47");
  if (row.disciplineInherited) rules.push("O26");
  if (cell.groups.length > 1) rules.push("O36");
  if (typeExplicit) rules.push("O44", "O21");
  else if (kind === "cycle") rules.push("O51");
  if (slots.length > 1) rules.push("O19", "O53");
  if (control) rules.push("O30", "O42");
  if (control?.explicitTime) rules.push("O37");
  if (controlSameMainDate && !control.explicitTime) rules.push("O29");
  if (hasSourceExceptions) rules.push("O33");
  if (calendarResolution.mode !== "none") rules.push("O32", "O34");
  return [...new Set(rules)];
}

function parseRecord(cycle, row, cell, options) {
  const text = normalizeCellText(cell.text);
  const range = parseRange(text);
  const slots = parseTimeSlots(row.timeText);
  if (!range || !slots.length) return null;

  const typeMatch = text.match(TYPE_RE);
  const typeExplicit = Boolean(typeMatch);
  const kind = typeMatch?.[1].toLowerCase() === "лекции" ? "lecture" : "cycle";
  const baseMainDates = expandWorkingRange(range, options);
  const control = parseControl(text, options.year);
  const calendarResolution = resolveConditionalCalendarExceptions({
    mainDates: baseMainDates,
    control,
    declaredDays: row.declaredDays,
    candidates: options.conditionalCalendarExceptions,
  });
  const mainDates = calendarResolution.mainDates;
  const controlSameMainDate = Boolean(control && mainDates.includes(control.date));
  const uniqueEducationDates = new Set(mainDates);
  if (control) uniqueEducationDates.add(control.date);

  const warnings = [];
  const envelope = envelopeDates(cycle.envelope, options.year);
  if (envelope && mainDates.some((date) => date < envelope.start || date > envelope.end)) {
    warnings.push(`O35: series range ${range.raw} leaves cycle ${cycle.cycleNo} envelope ${cycle.envelope.start}-${cycle.envelope.end}`);
  }
  if (uniqueEducationDates.size !== row.declaredDays) {
    warnings.push(`O20/O30: К.дн.=${row.declaredDays}, resolved unique education/control dates=${uniqueEducationDates.size}`);
  }

  return {
    discipline: row.discipline,
    disciplineRaw: row.discipline,
    disciplineNormalized: row.discipline,
    cycleNo: cycle.cycleNo,
    cycleId: `cycle-${cycle.cycleNo}`,
    groups: [...cell.groups],
    kind,
    typeRaw: kind === "lecture" ? "лекции" : "циклы",
    typeExplicit,
    sourceSlots: slots,
    startTime: slots[0].startTime,
    endTime: slots.at(-1).endTime,
    mainRange: range.raw,
    mainDates,
    control,
    declaredDays: row.declaredDays,
    calendarResolution: {
      mode: calendarResolution.mode,
      baseCount: calendarResolution.baseCount,
      resolvedCount: calendarResolution.resolvedCount,
      appliedDates: calendarResolution.applied.map((candidate) => candidate.date),
      keptDates: calendarResolution.kept.map((candidate) => candidate.date),
    },
    status: warnings.length ? "needs_review" : "ok",
    warnings,
    ruleIds: recordRuleIds({
      cycle,
      row,
      cell,
      kind,
      typeExplicit,
      slots,
      control,
      controlSameMainDate,
      hasSourceExceptions: options.sourceCalendarExceptions.size > 0,
      calendarResolution,
    }),
    rawSource: `${row.discipline} | ${row.timeText} | К.дн. ${row.declaredDays} | ${text}`,
    references: [{ role: "lesson", range: reference(cycle, row, cell) }],
    geometry: {
      pageNumber: cycle.pageNumber,
      cycleNo: cycle.cycleNo,
      rowIndex: row.rowIndex,
      bbox: [...cell.bbox],
      groups: [...cell.groups],
    },
  };
}

function materializeRecord(record) {
  const userSeries = [];
  const mainDates = [...record.mainDates];
  const sameDateControl = record.control && mainDates.includes(record.control.date) && !record.control.explicitTime;
  const normalDates = sameDateControl ? mainDates.filter((date) => date !== record.control.date) : mainDates;

  if (normalDates.length) {
    userSeries.push({
      discipline: record.discipline,
      disciplineRaw: record.disciplineRaw,
      disciplineNormalized: record.disciplineNormalized,
      startTime: record.startTime,
      endTime: record.endTime,
      dates: normalDates,
      kind: record.kind,
      typeRaw: record.typeRaw,
      groups: [...record.groups],
      cycleId: record.cycleId,
      sourceNote: null,
      location: "",
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
    userSeries.push({
      discipline: record.discipline,
      disciplineRaw: record.disciplineRaw,
      disciplineNormalized: record.disciplineNormalized,
      startTime: controlTime.startTime,
      endTime: controlTime.endTime,
      dates: [record.control.date],
      kind: "credit",
      typeRaw: "зачет",
      groups: [...record.groups],
      cycleId: record.cycleId,
      sourceNote: null,
      location: "",
      status: record.status,
      warnings: [...record.warnings],
      ruleIds: [...record.ruleIds],
      rawSource: record.rawSource,
      references: record.references.map((item) => ({ ...item })),
    });
  }

  return userSeries;
}

export function parseCycleRotationGeometry(geometry, { year, calendarExceptions = [], conditionalCalendarExceptions = [] } = {}) {
  if (geometry?.version !== 1 || geometry?.sourceProfile !== "cycle_rotation_grid") {
    throw new TypeError("cycle_rotation_grid geometry/v1 is required");
  }
  if (geometry?.sourceLanguage !== "ru") {
    const error = new Error("cycle_rotation_grid production geometry must come from Russian source_part");
    error.code = "OMG_CYCLE_ROTATION_RU_REQUIRED";
    throw error;
  }
  if (!Number.isInteger(Number(year))) throw new TypeError("cycle_rotation_grid requires explicit calendar year");

  const numericYear = Number(year);
  const sourceCalendarExceptions = new Set(
    (Array.isArray(geometry.sourceCalendarExceptions) ? geometry.sourceCalendarExceptions : [])
      .map((value) => normalizeExceptionDate(value, numericYear)),
  );
  const metadataExceptions = new Set(calendarExceptions.map((value) => normalizeExceptionDate(value, numericYear)));
  const unconditionalExceptions = new Set([...sourceCalendarExceptions, ...metadataExceptions]);
  const options = {
    year: numericYear,
    calendarExceptions: unconditionalExceptions,
    sourceCalendarExceptions,
    conditionalCalendarExceptions: normalizeConditionalExceptions(conditionalCalendarExceptions, numericYear),
  };
  const groups = [...new Set((geometry.cycles || []).flatMap((cycle) => (cycle.groups || []).map((group) => String(group.code))))];
  const sourceSeries = [];
  const diagnostics = [];

  for (const cycle of geometry.cycles || []) {
    for (const row of cycle.rows || []) {
      for (const cell of row.groupCells || []) {
        const record = parseRecord(cycle, row, { ...cell, groups: cell.groups.map(String) }, options);
        if (record) sourceSeries.push(record);
        else diagnostics.push(`cycle ${cycle.cycleNo} row ${row.rowIndex}: unresolved ${compact(cell.text).slice(0, 120)}`);
      }
    }
  }

  return { groups, sourceSeries, diagnostics };
}

function calendarYear(metadata) {
  const start = String(metadata?.period?.start_date ?? metadata?.period?.startDate ?? "").match(/^(20\d{2})-/);
  if (!start) throw new TypeError("cycle_rotation_grid metadata.period.start_date is required");
  return Number(start[1]);
}

export function buildCycleRotationCanonicalCandidate(geometry, { metadata, source } = {}) {
  const group = String(metadata?.groupCode ?? metadata?.group ?? "").trim();
  if (!group) throw new TypeError("cycle_rotation_grid metadata.group is required");

  const parsed = parseCycleRotationGeometry(geometry, {
    year: calendarYear(metadata),
    calendarExceptions: metadata?.calendarExceptions || [],
    conditionalCalendarExceptions: metadata?.conditionalCalendarExceptions || [],
  });
  if (!parsed.groups.includes(group)) {
    const error = new Error(`cycle_rotation_grid geometry does not contain group ${group}`);
    error.code = "OMG_CYCLE_ROTATION_GROUP_NOT_FOUND";
    throw error;
  }
  if (parsed.diagnostics.length) {
    const error = new Error(`cycle_rotation_grid has ${parsed.diagnostics.length} unresolved diagnostic(s)`);
    error.code = "OMG_CYCLE_ROTATION_NEEDS_REVIEW";
    error.diagnostics = parsed.diagnostics;
    throw error;
  }

  const sourceSeries = parsed.sourceSeries.filter((record) => record.groups.includes(group));
  if (!sourceSeries.length) {
    const error = new Error(`cycle_rotation_grid produced no source series for group ${group}`);
    error.code = "OMG_CYCLE_ROTATION_EMPTY";
    throw error;
  }
  const userSeries = sourceSeries.flatMap(materializeRecord).map((series) => ({
    ...series,
    jointGroups: series.groups.filter((code) => code !== group),
  }));

  const batch = buildOmgmuCanonicalBatch({
    metadata: {
      ...metadata,
      parser: metadata?.parser || "omgmu-cycle-rotation-grid/o01-o72",
    },
    source,
    series: userSeries,
  });

  return { batch, sourceSeries, userSeries, groups: parsed.groups };
}

export function buildCycleRotationCanonicalBatch(geometry, options = {}) {
  return buildCycleRotationCanonicalCandidate(geometry, options).batch;
}

export const cycleRotationInternals = Object.freeze({
  normalizeCellText,
  parseTimeSlots,
  parseRange,
  parseControl,
  materializeRecord,
  resolveConditionalCalendarExceptions,
});
