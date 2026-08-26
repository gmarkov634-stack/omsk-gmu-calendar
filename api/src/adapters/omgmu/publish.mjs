export const OMG_MU_MANUAL_REVIEW_GROUPS = new Set(["2113", "2114", "389", "393"]);

function requireStorageKeyResolver(resolveStorageKey) {
  if (typeof resolveStorageKey !== "function") {
    throw new TypeError("OmGMU publication storage-key resolver is required");
  }
  return resolveStorageKey;
}

function assertPublicationContext(schedule) {
  const university = String(schedule?.university || "").trim();
  const program = String(schedule?.program || "").trim();
  const course = String(schedule?.course || "").trim();
  const groupId = String(schedule?.group?.id || "").trim();
  const academicYear = String(schedule?.academicYear || "").trim();
  const semester = Number(schedule?.semester);
  if (!university || !program || !course || !groupId || !academicYear || ![1, 2].includes(semester)) {
    throw new Error("Schedule is missing publication context or period");
  }
}

export function scheduleObjectKey(schedule, resolveStorageKey) {
  assertPublicationContext(schedule);
  const key = String(requireStorageKeyResolver(resolveStorageKey)(schedule) || "").trim();
  if (!key) throw new Error("Storage-key resolver returned an empty key");
  return key;
}

export function publicationDecision(schedule, resolveStorageKey) {
  const group = String(schedule?.group?.code || "").trim();
  const events = Array.isArray(schedule?.events) ? schedule.events : [];
  if (!group) return { publish: false, reason: "missing-group" };
  if (!events.length) return { publish: false, reason: "empty-schedule" };

  if (OMG_MU_MANUAL_REVIEW_GROUPS.has(group)) {
    if (schedule?.review?.status !== "approved") return { publish: false, reason: "manual-review-pending" };
    if (!schedule?.review?.sourceSha256) return { publish: false, reason: "manual-review-missing-source-hash" };
    if (!events.every((event) => event?.sourceType === "manual-review")) {
      return { publish: false, reason: "manual-review-untrusted-events" };
    }
  }

  const resolver = requireStorageKeyResolver(resolveStorageKey);
  try {
    return { publish: true, reason: "verified", key: scheduleObjectKey(schedule, resolver) };
  } catch {
    return { publish: false, reason: "missing-publication-period" };
  }
}

export function buildPublicationPlan(schedules, resolveStorageKey) {
  const resolver = requireStorageKeyResolver(resolveStorageKey);
  const entries = schedules.map((schedule) => {
    const decision = publicationDecision(schedule, resolver);
    return {
      group: String(schedule?.group?.code || ""),
      ...decision,
      key: decision.publish ? decision.key : null,
      schedule,
    };
  });
  return {
    version: 1,
    university: "omgmu",
    generatedAt: new Date().toISOString(),
    publishable: entries.filter((entry) => entry.publish),
    blocked: entries.filter((entry) => !entry.publish),
  };
}
