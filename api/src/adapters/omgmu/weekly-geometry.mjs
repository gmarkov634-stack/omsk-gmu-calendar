const TIME_START_RE = /^\s*[,;]?\s*(\d{1,2})[.:/](\d{2})\s*[-–]\s*(\d{1,2})[.:/](\d{2})(?!\d)/;
const DATE_ATOM_RE = /(?<!\d)(\d{2})\.(\d{2})(?:\s*[-–]\s*(\d{2})\.(\d{2}))?(?!\d)/g;
const COUNT_RE = /(\d+)\s*(зан(?:ятий|ятие|ятия)?\.?|з\.?|лекц(?:ий|ии|ия|и)?\.?|лек\.?)\s*[:.]*/i;
const PAIRED_COUNT_RE = /(\d+)\s*\/\s*(\d+)\s*(зан(?:ятий|ятие|ятия)?\.?|з\.?|лекц(?:ий|ии|ия|и)?\.?|лек\.?)\s*[:.]*/i;
const EXPLICIT_LOCATION_RE = /(?:БУЗОО|ФГБОУ|ФГБУ|(?:^|[^\p{L}\p{N}])(?:ауд\.?|каб\.?|ГК\.?|КЗ\.?|АЗ\.?|СГК\.?|ПАК\.?|ул\.?)|стационар|корпус|здание)/iu;

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim().replace(/^[,;\s]+|[,;\s]+$/g, "");
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function validDate(year, month, day) {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

function timeParts(segment) {
  const match = String(segment || "").match(TIME_START_RE);
  if (!match) return null;
  const [sh, sm, eh, em] = match.slice(1).map(Number);
  const duration = eh * 60 + em - (sh * 60 + sm);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59 || duration <= 0 || duration > 300) return null;
  return {
    match,
    startTime: `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`,
    endTime: `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`,
  };
}

function splitEventSegments(cellText) {
  const segments = [];
  let current = [];
  for (const raw of String(cellText || "").split(/\r?\n/)) {
    const line = raw.trim().replace(/(\d{1,2}[.:/]\d)\s+(\d)/g, "$1$2");
    if (!line) continue;
    if (timeParts(line)) {
      if (current.length) segments.push(current.join(" ").trim());
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) segments.push(current.join(" ").trim());
  return segments;
}

function dateAtoms(value, year) {
  const atoms = [];
  for (const match of String(value || "").matchAll(DATE_ATOM_RE)) {
    const sd = Number(match[1]);
    const sm = Number(match[2]);
    const ed = match[3] ? Number(match[3]) : sd;
    const em = match[4] ? Number(match[4]) : sm;
    if (!validDate(year, sm, sd) || !validDate(year, em, ed)) continue;
    atoms.push({
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      sd,
      sm,
      ed,
      em,
      range: Boolean(match[3]),
    });
  }
  return atoms;
}

function expandDates(value, weekday, { year, calendarExceptions }) {
  const atoms = dateAtoms(value, year);
  const dates = new Set();
  const warnings = [];

  for (const atom of atoms) {
    let cursor = new Date(Date.UTC(year, atom.sm - 1, atom.sd));
    const end = new Date(Date.UTC(year, atom.em - 1, atom.ed));
    if (end < cursor) {
      warnings.push(`date range reversed: ${atom.raw}`);
      continue;
    }

    if (atom.range) {
      while (cursor <= end) {
        const date = cursor.toISOString().slice(0, 10);
        if (cursor.getUTCDay() === weekday && !calendarExceptions.has(date)) dates.add(date);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    } else {
      const date = isoDate(year, atom.sm, atom.sd);
      if (new Date(`${date}T00:00:00Z`).getUTCDay() !== weekday) {
        // Preserve an explicit source date instead of dropping the whole
        // source-series. The weekday/date contradiction remains fail-closed
        // through needs_review and can be inspected for exactly the affected
        // geometry groups.
        warnings.push(`weekday mismatch: ${date}`);
      }
      if (!calendarExceptions.has(date)) dates.add(date);
    }
  }

  return { atoms, dates: [...dates].sort(), warnings: [...new Set(warnings)] };
}

function declarationInfo(remainder) {
  if (PAIRED_COUNT_RE.test(remainder)) return null;
  const match = remainder.match(COUNT_RE);
  if (!match) return null;
  return {
    count: Number(match[1]),
    rawUnit: match[2],
    lecture: /лекц|лек\./i.test(match[2]),
  };
}

function pairedDeclarationInfo(remainder) {
  const match = remainder.match(PAIRED_COUNT_RE);
  if (!match) return null;
  return {
    counts: [Number(match[1]), Number(match[2])],
    rawUnit: match[3],
    lecture: /лекц|лек\./i.test(match[3]),
  };
}

function titleAndLocation(remainder, atoms) {
  const count = remainder.match(COUNT_RE);
  const paired = remainder.match(PAIRED_COUNT_RE);
  const cuts = [count?.index, paired?.index, atoms[0]?.start].filter((value) => Number.isInteger(value));
  const cut = cuts.length ? Math.min(...cuts) : remainder.length;
  const title = compact(remainder.slice(0, cut)).replace(/[,:;.]+$/g, "").trim();
  const last = atoms.at(-1);
  const tail = last ? compact(remainder.slice(last.end)).replace(/^[,;:.\-–\s]+/, "").trim() : "";
  const location = tail && EXPLICIT_LOCATION_RE.test(tail) ? tail : "";
  const sourceNote = tail && !location ? tail : "";
  return { title, location, sourceNote };
}

function normalizedAliasMap(geometry) {
  return new Map((geometry.sourceAliases || []).map((item) => [compact(item.alias), compact(item.expansion)]).filter(([alias, expansion]) => alias && expansion));
}

function resolveSourceAlias(title, geometry) {
  const resolved = normalizedAliasMap(geometry).get(compact(title));
  return resolved ? { title: resolved, used: true } : { title: compact(title), used: false };
}

function physicalAlternatives(title) {
  const parts = compact(title).split("/").map(compact).filter(Boolean);
  if (parts.length < 3) return false;
  const joined = parts.join(" ");
  return /(?:физ(?:ическая)?\s*культура|\bф\.?к\.?\b|спорт)/iu.test(joined)
    && /(?:спортивные\s+игры|плавание|атлет(?:ическая|ическая)?\s+гимнастика|ат\.?\s*гимнастика)/iu.test(joined);
}

function seriesRuleIds({ location, atoms, declaration, extra = [] }) {
  const rules = ["O03", "O04", "O05", "O16", "O62", "O63", "O64", ...extra];
  if (declaration?.lecture) rules.push("O27");
  else if (declaration) rules.push("O57");
  if (location) rules.push("O58");
  if (atoms.length > 1) rules.push("O61");
  return [...new Set(rules)];
}

function referenceFor(geometry, row, cell) {
  const bbox = cell.bbox.map((value) => Number(value).toFixed(2)).join(",");
  return `pdf:p${geometry.pageNumber}:row-${row.rowIndex}:bbox-${bbox}:groups-${cell.groups.join("+")}`;
}

function makeSeries({ geometry, row, cell, segment, time, dates, atoms, discipline, location, sourceNote, declaration = null, extraRules = [], warnings = [], pairedCounts = null }) {
  return {
    discipline,
    disciplineRaw: discipline,
    disciplineNormalized: discipline,
    startTime: time.startTime,
    endTime: time.endTime,
    dates,
    dateExpression: atoms.map((atom) => atom.raw).join("; "),
    declaredCount: declaration?.count ?? null,
    declaredCounts: pairedCounts ? [...pairedCounts] : null,
    declaredUnit: declaration?.rawUnit ?? null,
    location,
    sourceNote,
    kind: declaration?.lecture ? "lecture" : "unknown",
    typeRaw: declaration?.lecture ? "лекция" : null,
    groups: [...cell.groups],
    rawSource: segment,
    references: [{ role: "lesson", range: referenceFor(geometry, row, cell) }],
    ruleIds: seriesRuleIds({ location, atoms, declaration, extra: extraRules }),
    status: warnings.length ? "needs_review" : "ok",
    warnings: [...new Set(warnings)],
    sourceWeekday: row.weekday,
    geometry: {
      pageNumber: geometry.pageNumber,
      rowIndex: row.rowIndex,
      bbox: [...cell.bbox],
      groups: [...cell.groups],
    },
  };
}

function parseSegment(geometry, row, cell, segment, options) {
  const time = timeParts(segment);
  if (!time) return [];
  const remainder = segment.slice(time.match[0].length).trim().replace(/^[,;]+\s*/, "");
  const { atoms, dates, warnings: dateWarnings } = expandDates(remainder, row.weekday, options);
  if (!dates.length) return [];
  const parsedText = titleAndLocation(remainder, atoms);
  if (!parsedText.title) return [];

  const alias = resolveSourceAlias(parsedText.title, geometry);
  const paired = pairedDeclarationInfo(remainder);
  if (paired) {
    const total = paired.counts[0] + paired.counts[1];
    const pairWarnings = [...dateWarnings];
    if (total !== dates.length) pairWarnings.push(`O13: declared ${paired.counts.join("/")} occurrence(s), resolved ${dates.length} date(s)`);

    if (physicalAlternatives(alias.title)) {
      const declaration = { count: total, rawUnit: paired.rawUnit, lecture: paired.lecture };
      return [makeSeries({
        geometry, row, cell, segment, time, dates, atoms,
        discipline: "Физическая культура и спорт",
        location: parsedText.location,
        sourceNote: [parsedText.sourceNote, `Варианты из источника: ${alias.title}`].filter(Boolean).join("; "),
        declaration,
        pairedCounts: paired.counts,
        extraRules: ["O14", ...(alias.used ? ["O59"] : [])],
        warnings: pairWarnings,
      })];
    }

    const disciplines = alias.title.split("/").map(compact).filter(Boolean);
    if (disciplines.length !== 2 || pairWarnings.length) {
      return [makeSeries({
        geometry, row, cell, segment, time, dates, atoms,
        discipline: alias.title,
        location: parsedText.location,
        sourceNote: parsedText.sourceNote,
        declaration: { count: total, rawUnit: paired.rawUnit, lecture: paired.lecture },
        pairedCounts: paired.counts,
        extraRules: ["O13", ...(alias.used ? ["O59"] : [])],
        warnings: [...pairWarnings, ...(disciplines.length !== 2 ? ["O13: paired counter does not map to exactly two disciplines"] : [])],
      })];
    }

    const common = {
      geometry, row, cell, segment, time, atoms,
      location: parsedText.location,
      sourceNote: parsedText.sourceNote,
      pairedCounts: paired.counts,
      extraRules: ["O13", ...(alias.used ? ["O59"] : [])],
      warnings: [],
    };
    return [
      makeSeries({ ...common, dates: dates.slice(0, paired.counts[0]), discipline: disciplines[0], declaration: { count: paired.counts[0], rawUnit: paired.rawUnit, lecture: paired.lecture } }),
      makeSeries({ ...common, dates: dates.slice(paired.counts[0]), discipline: disciplines[1], declaration: { count: paired.counts[1], rawUnit: paired.rawUnit, lecture: paired.lecture } }),
    ];
  }

  const declaration = declarationInfo(remainder);
  const warnings = [...dateWarnings];
  if (declaration && declaration.count !== dates.length) {
    const rule = declaration.lecture ? "O27" : "O57";
    warnings.push(`${rule}: declared ${declaration.count} occurrence(s), resolved ${dates.length} date(s)`);
  }
  return [makeSeries({
    geometry, row, cell, segment, time, dates, atoms,
    discipline: alias.title,
    location: parsedText.location,
    sourceNote: parsedText.sourceNote,
    declaration,
    extraRules: alias.used ? ["O59"] : [],
    warnings,
  })];
}

function intersect(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function markExactSlotConflicts(series) {
  for (let leftIndex = 0; leftIndex < series.length; leftIndex += 1) {
    const left = series[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < series.length; rightIndex += 1) {
      const right = series[rightIndex];
      if (left.disciplineNormalized === right.disciplineNormalized) continue;
      if (left.startTime !== right.startTime || left.endTime !== right.endTime) continue;
      const sharedGroups = intersect(left.groups, right.groups);
      if (!sharedGroups.length) continue;
      const sharedDates = intersect(left.dates, right.dates);
      if (!sharedDates.length) continue;

      const warning = (other) => `O06: same group/date/time has another discipline (${other}) on ${sharedDates.join(", ")}`;
      left.warnings = [...new Set([...left.warnings, warning(right.disciplineNormalized)])];
      right.warnings = [...new Set([...right.warnings, warning(left.disciplineNormalized)])];
      left.ruleIds = [...new Set([...left.ruleIds, "O06"])];
      right.ruleIds = [...new Set([...right.ruleIds, "O06"])];
      left.status = "needs_review";
      right.status = "needs_review";
    }
  }
  return series;
}

export function parseWeeklyGeometry(geometry, { year, calendarExceptions = [] } = {}) {
  if (geometry?.version !== 1 || geometry?.sourceProfile !== "weekly_grid") {
    throw new TypeError("weekly_grid geometry/v1 is required");
  }
  if (geometry?.sourceLanguage !== "ru") {
    const error = new Error("weekly_grid production geometry must come from Russian source_part");
    error.code = "OMG_WEEKLY_GRID_RU_REQUIRED";
    throw error;
  }
  if (!Number.isInteger(Number(year))) throw new TypeError("weekly_grid parser requires explicit calendar year");

  const options = {
    year: Number(year),
    calendarExceptions: new Set((calendarExceptions || []).map(String)),
  };
  const groupCodes = geometry.groups?.map((group) => String(group.code)) || [];
  if (groupCodes.length < 2) throw new TypeError("weekly_grid geometry requires at least two group columns");

  const series = [];
  const diagnostics = [];
  for (const row of geometry.rows || []) {
    if (![1, 2, 3, 4, 5, 6].includes(row.weekday)) {
      diagnostics.push(`row ${row.rowIndex}: missing weekday context`);
      continue;
    }
    for (const cell of row.cells || []) {
      const covered = (cell.groups || []).map(String);
      if (!covered.length || covered.some((code) => !groupCodes.includes(code))) {
        diagnostics.push(`row ${row.rowIndex}: invalid geometry group span`);
        continue;
      }
      const segments = splitEventSegments(cell.text);
      if (!segments.length && compact(cell.text)) {
        diagnostics.push(`row ${row.rowIndex}: no event segment in ${compact(cell.text).slice(0, 120)}`);
      }
      for (const segment of segments) {
        const parsed = parseSegment(geometry, row, { ...cell, groups: covered }, segment, options);
        if (parsed.length) series.push(...parsed);
        else diagnostics.push(`row ${row.rowIndex}: unresolved segment ${segment.slice(0, 120)}`);
      }
    }
  }

  return { groups: groupCodes, series: markExactSlotConflicts(series), diagnostics };
}

export const weeklyGeometryInternals = Object.freeze({
  splitEventSegments,
  expandDates,
  titleAndLocation,
  declarationInfo,
  pairedDeclarationInfo,
  resolveSourceAlias,
  physicalAlternatives,
  markExactSlotConflicts,
});
