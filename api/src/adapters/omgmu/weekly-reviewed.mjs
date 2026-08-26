function text(value) {
  return String(value ?? "").trim();
}

function sameStream(left, right) {
  const a = left == null ? null : text(left);
  const b = right == null ? null : text(right);
  return a === b;
}

function matches(series, match = {}) {
  return (
    (series.disciplineNormalized ?? series.discipline) === match.discipline &&
    series.startTime === match.startTime &&
    series.endTime === match.endTime &&
    series.dateExpression === match.dateExpression
  );
}

function reviewMarker(registry, entry) {
  return `manual-review:${registry.applicationConfirmedOn}:${entry.group}`;
}

function applyResolution(series, resolution, registry, entry) {
  const output = {
    ...series,
    dates: [...resolution.dates],
    warnings: [],
    ruleIds: [...new Set([...(series.ruleIds || []), reviewMarker(registry, entry)])],
    status: "warning",
    reviewEvidence: {
      status: "approved",
      group: String(entry.group),
      reason: entry.reason,
      reviewedBy: entry.reviewedBy,
      reviewedAt: entry.reviewedAt,
      applicationConfirmedBy: registry.applicationConfirmedBy,
      applicationConfirmedOn: registry.applicationConfirmedOn,
      sourceFile: entry.sourceFile,
      sourceSha256: entry.sourceSha256,
      decision: entry.decision,
      resolutionType: resolution.type,
    },
  };
  output.warnings.push(`Approved source-bound manual review applied: ${entry.decision}`);
  return output;
}

/**
 * Apply an already-approved, exact-source manual review to one group's parsed
 * weekly source-series. This layer is deliberately source-bound: changed PDF
 * hash, group/course/stream mismatch, missing machine-readable resolution, or
 * a resolution matching anything other than exactly one series all fail
 * closed. It does not create a new parsing rule.
 */
export function applyApprovedWeeklyReview(sourceSeries, { metadata, source, registry } = {}) {
  if (!registry || registry.version !== 2 || registry.university !== "omgmu" || !Array.isArray(registry.groups)) {
    return { series: sourceSeries, review: null };
  }

  const group = text(metadata?.groupCode ?? metadata?.group);
  const course = Number(metadata?.course);
  const stream = metadata?.stream ?? null;
  const entry = registry.groups.find((candidate) => (
    candidate.status === "approved" &&
    text(candidate.group) === group &&
    Number(candidate.course) === course &&
    sameStream(candidate.stream, stream)
  ));
  if (!entry) return { series: sourceSeries, review: null };

  if (!entry.canonicalResolution) {
    const error = new Error(`Approved weekly review for ${group} has no canonicalResolution`);
    error.code = "OMG_WEEKLY_REVIEW_RESOLUTION_REQUIRED";
    throw error;
  }
  if (text(source?.fileName) !== text(entry.sourceFile)) {
    const error = new Error(`Weekly review source file mismatch for ${group}`);
    error.code = "OMG_WEEKLY_REVIEW_SOURCE_FILE_MISMATCH";
    throw error;
  }
  if (text(source?.fileHash) !== text(entry.sourceSha256)) {
    const error = new Error(`Weekly review source SHA changed for ${group}`);
    error.code = "OMG_WEEKLY_REVIEW_SOURCE_CHANGED";
    throw error;
  }

  const resolution = entry.canonicalResolution;
  if (!["override-series-dates", "accept-explicit-date"].includes(resolution.type) || !Array.isArray(resolution.dates) || !resolution.dates.length) {
    const error = new Error(`Unsupported weekly canonicalResolution for ${group}`);
    error.code = "OMG_WEEKLY_REVIEW_RESOLUTION_INVALID";
    throw error;
  }

  const matchingIndexes = [];
  sourceSeries.forEach((series, index) => {
    if ((series.groups || []).map(String).includes(group) && matches(series, resolution.match)) matchingIndexes.push(index);
  });
  if (matchingIndexes.length !== 1) {
    const error = new Error(`Weekly review for ${group} matched ${matchingIndexes.length} source-series; expected exactly 1`);
    error.code = "OMG_WEEKLY_REVIEW_MATCH_AMBIGUOUS";
    throw error;
  }

  const reviewed = sourceSeries.map((series, index) => (
    index === matchingIndexes[0] ? applyResolution(series, resolution, registry, entry) : series
  ));

  return {
    series: reviewed,
    review: {
      group,
      sourceFile: entry.sourceFile,
      sourceSha256: entry.sourceSha256,
      reason: entry.reason,
      decision: entry.decision,
      resolutionType: resolution.type,
      marker: reviewMarker(registry, entry),
    },
  };
}
