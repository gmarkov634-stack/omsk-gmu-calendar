function minutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))];
}

function sameArray(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function compatibleText(left, right) {
  return !left || !right || left === right;
}

function sourceEvidence(series, date) {
  return {
    date,
    discipline: series.disciplineNormalized ?? series.discipline,
    startTime: series.startTime,
    endTime: series.endTime,
    dateExpression: series.dateExpression ?? null,
    declaredCount: series.declaredCount ?? null,
    declaredUnit: series.declaredUnit ?? null,
    rawSource: series.rawSource ?? null,
    references: (series.references || []).map((reference) => ({ ...reference })),
    ruleIds: [...(series.ruleIds || [])],
    geometry: series.geometry ? {
      ...series.geometry,
      bbox: Array.isArray(series.geometry.bbox) ? [...series.geometry.bbox] : series.geometry.bbox,
      groups: Array.isArray(series.geometry.groups) ? [...series.geometry.groups] : series.geometry.groups,
    } : null,
  };
}

function occurrence(series, date) {
  return {
    ...series,
    dates: [date],
    groups: [...(series.groups || [])],
    references: (series.references || []).map((reference) => ({ ...reference })),
    ruleIds: [...(series.ruleIds || [])],
    warnings: [...(series.warnings || [])],
    sourceSeriesEvidence: [sourceEvidence(series, date)],
    o65Merged: false,
  };
}

function lastEvidence(series) {
  return series.sourceSeriesEvidence?.at(-1) || null;
}

function firstEvidence(series) {
  return series.sourceSeriesEvidence?.[0] || null;
}

function canMerge(left, right, maxGapMinutes) {
  if (left.status !== "ok" || right.status !== "ok") return false;
  if (left.dates[0] !== right.dates[0]) return false;
  if ((left.disciplineNormalized ?? left.discipline) !== (right.disciplineNormalized ?? right.discipline)) return false;
  if ((left.kind || "unknown") !== (right.kind || "unknown")) return false;
  if ((left.typeRaw || null) !== (right.typeRaw || null)) return false;
  if (!sameArray(left.groups, right.groups)) return false;
  if (!compatibleText(left.location, right.location) || !compatibleText(left.sourceNote, right.sourceNote)) return false;

  const gap = minutes(right.startTime) - minutes(left.endTime);
  if (!Number.isFinite(gap) || gap < 0 || gap > maxGapMinutes) return false;

  const leftLast = lastEvidence(left)?.geometry;
  const rightFirst = firstEvidence(right)?.geometry;
  if (!leftLast || !rightFirst) return false;
  if (leftLast.pageNumber !== rightFirst.pageNumber) return false;
  if (Number(rightFirst.rowIndex) !== Number(leftLast.rowIndex) + 1) return false;
  return true;
}

function mergePair(left, right) {
  const references = [];
  const seenReferences = new Set();
  for (const reference of [...(left.references || []), ...(right.references || [])]) {
    const key = `${reference.role}|${reference.range}`;
    if (seenReferences.has(key)) continue;
    seenReferences.add(key);
    references.push({ ...reference });
  }

  const evidence = [...left.sourceSeriesEvidence, ...right.sourceSeriesEvidence];
  return {
    ...left,
    startTime: left.startTime,
    endTime: right.endTime,
    location: left.location || right.location || "",
    sourceNote: left.sourceNote || right.sourceNote || "",
    rawSource: unique([left.rawSource, right.rawSource]).join("\n--- O65 source-series ---\n"),
    references,
    ruleIds: unique([...(left.ruleIds || []), ...(right.ruleIds || []), "O65"]),
    warnings: unique([...(left.warnings || []), ...(right.warnings || [])]),
    dateExpression: left.dates[0],
    declaredCount: null,
    declaredUnit: null,
    sourceSeriesEvidence: evidence,
    geometry: {
      merged: true,
      pageNumber: firstEvidence(left)?.geometry?.pageNumber ?? null,
      rows: evidence.map((part) => part.geometry?.rowIndex).filter(Number.isFinite),
      groups: [...left.groups],
    },
    o65Merged: true,
  };
}

/**
 * Materialize weekly_grid source-series into user-visible one-date series.
 *
 * Source series are never mutated or discarded: `sourceSeries` in the return
 * value remains the independent parser result. `userSeries` may merge only
 * adjacent, already-valid occurrences under O65. The merged occurrence keeps
 * structured evidence from every source series in `sourceSeriesEvidence` and
 * unions all PDF references for canonical traceability.
 *
 * The default five-minute gap is intentionally limited to the currently
 * verified O65 pattern (15:55 -> 16:00). A broader gap requires new source
 * evidence instead of silent generalization.
 */
export function materializeWeeklyUserSeries(sourceSeries, { group, maxGapMinutes = 5 } = {}) {
  const groupCode = String(group || "").trim();
  if (!groupCode) throw new TypeError("O65 materialization requires group");
  if (!Number.isFinite(Number(maxGapMinutes)) || Number(maxGapMinutes) < 0) {
    throw new TypeError("maxGapMinutes must be a non-negative number");
  }

  const filtered = sourceSeries.filter((series) => (series.groups || []).map(String).includes(groupCode));
  const occurrences = filtered.flatMap((series) => (series.dates || []).map((date) => occurrence(series, date)));
  occurrences.sort((left, right) => [
    left.dates[0], left.startTime, left.endTime, left.disciplineNormalized ?? left.discipline,
  ].join("|").localeCompare([
    right.dates[0], right.startTime, right.endTime, right.disciplineNormalized ?? right.discipline,
  ].join("|")));

  const userSeries = [];
  const merges = [];
  for (const item of occurrences) {
    const previous = userSeries.at(-1);
    if (previous && canMerge(previous, item, Number(maxGapMinutes))) {
      const merged = mergePair(previous, item);
      userSeries[userSeries.length - 1] = merged;
      merges.push({
        ruleId: "O65",
        group: groupCode,
        date: merged.dates[0],
        discipline: merged.disciplineNormalized ?? merged.discipline,
        startTime: merged.startTime,
        endTime: merged.endTime,
        sourceReferences: merged.references.map((reference) => reference.range),
      });
    } else {
      userSeries.push(item);
    }
  }

  return {
    sourceSeries: filtered,
    userSeries,
    merges,
  };
}

export const weeklyO65Internals = Object.freeze({ canMerge, sourceEvidence });
