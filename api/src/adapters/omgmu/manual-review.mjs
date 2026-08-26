import crypto from "node:crypto";

export function sourceSha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function validateReview(review, { expectedGroup, sourceHash } = {}) {
  const errors = [];
  if (!review || review.version !== 1) errors.push("unsupported-version");
  if (!review?.group) errors.push("missing-group");
  if (expectedGroup && String(review?.group) !== String(expectedGroup)) errors.push("group-mismatch");
  if (!review?.sourceSha256) errors.push("missing-source-sha256");
  if (sourceHash && review?.sourceSha256 !== sourceHash) errors.push("source-changed");
  if (review?.status !== "approved") errors.push("not-approved");
  if (!review?.reviewedBy) errors.push("missing-reviewer");
  if (!review?.reviewedAt || Number.isNaN(Date.parse(review.reviewedAt))) errors.push("invalid-reviewed-at");
  if (!Array.isArray(review?.events) || review.events.length === 0) errors.push("empty-events");

  const seen = new Set();
  for (const [index, event] of (review?.events || []).entries()) {
    if (!event?.title?.trim()) errors.push(`event-${index}-missing-title`);
    if (!event?.start || Number.isNaN(Date.parse(event.start))) errors.push(`event-${index}-invalid-start`);
    if (!event?.end || Number.isNaN(Date.parse(event.end))) errors.push(`event-${index}-invalid-end`);
    if (event?.start && event?.end && Date.parse(event.end) <= Date.parse(event.start)) errors.push(`event-${index}-invalid-duration`);
    const key = [event?.start, event?.end, event?.title?.trim(), event?.location || ""].join("|");
    if (seen.has(key)) errors.push(`event-${index}-duplicate`);
    seen.add(key);
  }
  return { valid: errors.length === 0, errors };
}

export function applyApprovedReview(schedule, review, { sourceHash } = {}) {
  const check = validateReview(review, { expectedGroup: schedule?.group?.code, sourceHash });
  if (!check.valid) {
    const error = new Error(`Manual review is invalid: ${check.errors.join(", ")}`);
    error.code = "INVALID_MANUAL_REVIEW";
    error.details = check.errors;
    throw error;
  }
  return {
    ...schedule,
    review: {
      status: "approved",
      reviewedBy: review.reviewedBy,
      reviewedAt: review.reviewedAt,
      sourceSha256: review.sourceSha256,
    },
    events: review.events.map((event, index) => ({
      id: event.id || `omgmu-${review.group}-manual-${index + 1}`,
      title: event.title.trim(),
      start: event.start,
      end: event.end,
      location: event.location || "",
      sourceType: "manual-review",
    })),
  };
}
