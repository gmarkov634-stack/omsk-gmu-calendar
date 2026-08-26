import { buildOmgmuCanonicalBatch } from "./canonical.mjs";
import { parseWeeklyGeometry } from "./weekly-geometry.mjs";
import { materializeWeeklyUserSeries } from "./weekly-o65.mjs";
import { applyApprovedWeeklyReview } from "./weekly-reviewed.mjs";

function calendarYear(metadata) {
  const start = String(metadata?.period?.start_date ?? metadata?.period?.startDate ?? "").match(/^(20\d{2})-/);
  if (!start) throw new TypeError("weekly_grid metadata.period.start_date is required to determine calendar year");
  return Number(start[1]);
}

function groupSeries(series, group) {
  return series.map((item) => ({
    ...item,
    jointGroups: item.groups.filter((code) => code !== group),
  }));
}

export function buildWeeklyGridCanonicalCandidate(geometry, { metadata, source, reviewRegistry = null } = {}) {
  const group = String(metadata?.groupCode ?? metadata?.group ?? "").trim();
  if (!group) throw new TypeError("weekly_grid metadata.group is required");

  const parsed = parseWeeklyGeometry(geometry, {
    year: calendarYear(metadata),
    calendarExceptions: metadata?.calendarExceptions || [],
  });

  if (!parsed.groups.includes(group)) {
    const error = new Error(`weekly_grid geometry does not contain group ${group}`);
    error.code = "OMG_WEEKLY_GRID_GROUP_NOT_FOUND";
    throw error;
  }
  if (parsed.diagnostics.length) {
    const error = new Error(`weekly_grid has ${parsed.diagnostics.length} unresolved geometry/parser diagnostic(s)`);
    error.code = "OMG_WEEKLY_GRID_NEEDS_REVIEW";
    error.diagnostics = parsed.diagnostics;
    throw error;
  }

  const reviewed = applyApprovedWeeklyReview(parsed.series, {
    metadata: { ...metadata, group },
    source,
    registry: reviewRegistry,
  });

  // O65 runs only after parser + source-bound review have produced validated
  // independent source-series for this exact official PDF revision.
  const materialized = materializeWeeklyUserSeries(reviewed.series, { group, maxGapMinutes: 5 });
  if (!materialized.sourceSeries.length) {
    const error = new Error(`weekly_grid produced no source series for group ${group}`);
    error.code = "OMG_WEEKLY_GRID_EMPTY";
    throw error;
  }

  const userSeries = groupSeries(materialized.userSeries, group);
  const batch = buildOmgmuCanonicalBatch({
    metadata: {
      ...metadata,
      parser: metadata?.parser || "omgmu-weekly-grid/o01-o72",
    },
    source,
    series: userSeries,
  });

  return {
    batch,
    sourceSeries: materialized.sourceSeries,
    userSeries,
    merges: materialized.merges,
    groups: parsed.groups,
    review: reviewed.review,
  };
}

export function buildWeeklyGridCanonicalBatch(geometry, options = {}) {
  return buildWeeklyGridCanonicalCandidate(geometry, options).batch;
}
