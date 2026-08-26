const TYPE_CODES = new Set([
  "lecture",
  "practice",
  "seminar",
  "laboratory",
  "consultation",
  "exam",
  "credit",
  "physical_education",
  "other",
  "unknown",
]);

const KIND_TO_TYPE = Object.freeze({
  lecture: "lecture",
  practice: "practice",
  seminar: "seminar",
  laboratory: "laboratory",
  consultation: "consultation",
  exam: "exam",
  credit: "credit",
  physical_education: "physical_education",
  other: "other",
  unknown: "unknown",
  cycle: "unknown",
});

function requiredString(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function optionalString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeAcademicYear(value) {
  const match = String(value || "").match(/(20\d{2})\D+(20\d{2}|\d{2})/);
  if (!match) throw new TypeError("metadata.academicYear must identify one academic year");
  const start = Number(match[1]);
  let end = Number(match[2]);
  if (match[2].length === 2) end = Math.floor(start / 100) * 100 + end;
  if (end < start) end += 100;
  if (end !== start + 1) throw new TypeError("metadata.academicYear must identify consecutive years");
  return `${start}/${end}`;
}

function normalizeSemester(value) {
  if (value === "autumn" || Number(value) === 1) return "autumn";
  if (value === "spring" || Number(value) === 2) return "spring";
  if (value === "summer" || value === "other") return value;
  throw new TypeError("metadata.semester must be autumn/spring/summer/other or 1/2");
}

function normalizeTime(value, name) {
  const match = String(value || "").trim().match(/^(\d{1,2})[.:](\d{2})$/);
  if (!match) throw new TypeError(`${name} must be hh:mm or hh.mm`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new TypeError(`${name} is outside clock range`);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeDate(value, name) {
  const date = requiredString(value, name);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) throw new TypeError(`${name} must be YYYY-MM-DD`);
  return date;
}

function normalizePeriod(period) {
  if (!period || typeof period !== "object") throw new TypeError("metadata.period is required");
  return {
    start_date: normalizeDate(period.start_date ?? period.startDate, "metadata.period.start_date"),
    end_date: normalizeDate(period.end_date ?? period.endDate, "metadata.period.end_date"),
    week1_start_date: normalizeDate(period.week1_start_date ?? period.week1StartDate, "metadata.period.week1_start_date"),
  };
}

function normalizeType(series) {
  const explicit = optionalString(series.typeCode);
  if (explicit) {
    if (!TYPE_CODES.has(explicit)) throw new TypeError(`Unsupported canonical typeCode: ${explicit}`);
    return explicit;
  }
  return KIND_TO_TYPE[String(series.kind || "").toLowerCase()] || "unknown";
}

function normalizeTypeRaw(series) {
  if (series.typeRaw != null) return optionalString(series.typeRaw);
  const kind = optionalString(series.kind);
  if (kind === "lecture") return "лекция";
  if (kind === "cycle") return "цикл";
  return kind;
}

function emptyDerived() {
  return {
    academic_week: null,
    sequence: { index: null, total: null, bucket: null },
    next_same_event: null,
    is_last_same_event: false,
    day: {
      index: null,
      total: null,
      remaining: null,
      next_event: null,
      gap_minutes: null,
      overlaps_next: false,
    },
    cycle: null,
    assessment: null,
  };
}

function sourceReferences(series) {
  if (!Array.isArray(series.references)) return [];
  return series.references.map((reference) => ({
    role: requiredString(reference.role, "series.references[].role"),
    range: requiredString(reference.range, "series.references[].range"),
  }));
}

function locations(series) {
  const raw = optionalString(series.location);
  if (!raw) return [];
  return [{ raw, building: null, room: null, address: null }];
}

function normalizeRuleIds(series) {
  return [...new Set((Array.isArray(series.ruleIds) ? series.ruleIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function normalizeWarnings(series) {
  return (Array.isArray(series.warnings) ? series.warnings : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function eventForDate({ metadata, source, series, date }) {
  const disciplineRaw = requiredString(series.disciplineRaw ?? series.discipline, "series.discipline");
  const disciplineNormalized = requiredString(series.disciplineNormalized ?? series.discipline, "series.disciplineNormalized");
  const status = series.status || "ok";
  if (!["ok", "warning", "needs_review"].includes(status)) throw new TypeError(`Unsupported parse status: ${status}`);
  const startTime = normalizeTime(series.startTime, "series.startTime");
  const endTime = normalizeTime(series.endTime, "series.endTime");

  return {
    schema_version: "1.0",
    system: {
      event_id: null,
      schedule_version_id: null,
      fingerprint: null,
      revision: null,
      created_at: null,
      updated_at: null,
    },
    university: { code: "omgmu", name: "ОмГМУ" },
    academic: {
      academic_year: metadata.academicYear,
      semester: metadata.semester,
      faculty_code: metadata.facultyCode,
      faculty_name: metadata.facultyName,
      course: metadata.course,
    },
    audience: {
      group: metadata.group,
      scope: series.scope || "whole_group",
      subgroups: Array.isArray(series.subgroups) ? [...new Set(series.subgroups.map(String))] : [],
      stream: optionalString(series.stream ?? metadata.stream),
    },
    timing: {
      date: normalizeDate(date, "series.dates[]"),
      start_time: startTime,
      end_time: endTime,
      all_day: false,
      time_mode: "floating",
    },
    lesson: {
      discipline: { raw: disciplineRaw, normalized: disciplineNormalized },
      type: { raw: normalizeTypeRaw(series), code: normalizeType(series) },
      teachers: [],
      locations: locations(series),
      source_note: optionalString(series.sourceNote),
      cycle_id: optionalString(series.cycleId),
      joint_groups: Array.isArray(series.jointGroups)
        ? [...new Set(series.jointGroups.map((value) => String(value).trim()).filter(Boolean))]
        : [],
    },
    source: {
      file_name: source.fileName,
      file_hash: source.fileHash,
      sheet: null,
      references: sourceReferences(series),
      raw_text: optionalString(series.rawSource),
    },
    parse: {
      status,
      rule_ids: normalizeRuleIds(series),
      warnings: normalizeWarnings(series),
    },
    derived: emptyDerived(),
    calendar: { title: null, description: null, location: null },
  };
}

export function buildOmgmuCanonicalBatch({ metadata, source, series }) {
  if (!metadata || typeof metadata !== "object") throw new TypeError("metadata is required");
  if (!source || typeof source !== "object") throw new TypeError("source is required");
  if (!Array.isArray(series)) throw new TypeError("series must be an array");

  const normalizedMetadata = {
    academicYear: normalizeAcademicYear(metadata.academicYear),
    semester: normalizeSemester(metadata.semester),
    facultyCode: requiredString(metadata.facultyCode ?? metadata.program, "metadata.facultyCode"),
    facultyName: optionalString(metadata.facultyName),
    course: Number(metadata.course),
    group: requiredString(metadata.groupCode ?? metadata.group, "metadata.group"),
    stream: optionalString(metadata.stream),
    period: normalizePeriod(metadata.period),
    parser: requiredString(metadata.parser || "omgmu-profile-rules", "metadata.parser"),
  };
  if (!Number.isInteger(normalizedMetadata.course) || normalizedMetadata.course < 1 || normalizedMetadata.course > 10) {
    throw new TypeError("metadata.course must be an integer from 1 to 10");
  }

  const normalizedSource = {
    fileName: requiredString(source.fileName, "source.fileName"),
    fileHash: optionalString(source.fileHash),
  };

  const events = [];
  for (const sourceSeries of series) {
    if (!sourceSeries || typeof sourceSeries !== "object") throw new TypeError("Every series item must be an object");
    if (!Array.isArray(sourceSeries.dates) || sourceSeries.dates.length === 0) {
      throw new TypeError("series.dates must contain at least one resolved date");
    }
    for (const date of [...new Set(sourceSeries.dates)]) {
      events.push(eventForDate({ metadata: normalizedMetadata, source: normalizedSource, series: sourceSeries, date }));
    }
  }
  events.sort((left, right) => `${left.timing.date}T${left.timing.start_time}`.localeCompare(`${right.timing.date}T${right.timing.start_time}`));

  return {
    schema_version: "1.0",
    schedule: {
      university_code: "omgmu",
      academic_year: normalizedMetadata.academicYear,
      semester: normalizedMetadata.semester,
      faculty_code: normalizedMetadata.facultyCode,
      course: normalizedMetadata.course,
      group: normalizedMetadata.group,
      period: normalizedMetadata.period,
      source_files: [normalizedSource.fileName],
      generated_at: null,
      parser: normalizedMetadata.parser,
      schedule_version_id: null,
      previous_schedule_version_id: null,
      content_fingerprint: null,
      version_created_at: null,
    },
    events,
  };
}
