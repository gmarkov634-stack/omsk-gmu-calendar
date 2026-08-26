const FORMAT = "canonical-reviewed/v1";
const PARSER_TYPE = "OMGMU_CANONICAL_REVIEWED_JSON";
const SHA_RE = /^[a-f0-9]{64}$/;

function fail(message, code = "CANONICAL_REVIEW_INVALID", details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
}

function clean(value, max = 500) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function sourceHash(value) {
  const text = clean(value, 80).toLowerCase();
  return text.startsWith("sha256:") ? text.slice(7) : text;
}

function semesterNumber(value) {
  if (value === "autumn") return 1;
  if (value === "spring") return 2;
  const number = Number(value);
  return [1, 2].includes(number) ? number : null;
}

function sameText(left, right) {
  if (!left || !right) return true;
  return clean(left, 100).toLowerCase() === clean(right, 100).toLowerCase();
}

function requireDependency(dependencies, name) {
  const dependency = dependencies?.[name];
  if (typeof dependency !== "function") {
    fail(`Canonical review dependency ${name} is required`, "CANONICAL_REVIEW_DEPENDENCY_MISSING", { dependency: name });
  }
  return dependency;
}

export function createOmgmuCanonicalReviewPolicy(dependencies = {}) {
  const normalizeAcademicYear = requireDependency(dependencies, "normalizeAcademicYear");
  const scheduleContext = requireDependency(dependencies, "scheduleContext");
  const validateScheduleBatch = requireDependency(dependencies, "validateScheduleBatch");
  const prepareSchedulePublication = requireDependency(dependencies, "prepareSchedulePublication");

  function validateContext(batch, review) {
    const context = scheduleContext(batch);
    const metadata = review.metadata || {};
    if (context.university !== "omgmu") fail("Canonical review accepts only ОмГМУ batches", "CANONICAL_REVIEW_CONTEXT_MISMATCH");
    if (metadata.program && !sameText(context.program, metadata.program)) fail("Batch program does not match source review", "CANONICAL_REVIEW_CONTEXT_MISMATCH");
    if (metadata.course && Number(context.course) !== Number(metadata.course)) fail("Batch course does not match source review", "CANONICAL_REVIEW_CONTEXT_MISMATCH");
    if (metadata.academicYear && normalizeAcademicYear(context.academicYear) !== normalizeAcademicYear(metadata.academicYear)) {
      fail("Batch academic year does not match source review", "CANONICAL_REVIEW_CONTEXT_MISMATCH");
    }
    if (metadata.semester && semesterNumber(context.semester) !== semesterNumber(metadata.semester)) {
      fail("Batch semester does not match source review", "CANONICAL_REVIEW_CONTEXT_MISMATCH");
    }
    if (!context.groupCode) fail("Batch has no group code", "CANONICAL_REVIEW_CONTEXT_MISMATCH");
    return context;
  }

  function bindReviewedSource(rawBatch, review) {
    const batch = structuredClone(rawBatch);
    const filename = clean(review.metadata?.filename, 200);
    const sha = clean(review.sourceSha256, 64).toLowerCase();
    if (!filename || !SHA_RE.test(sha)) fail("Review has no valid PDF filename/SHA", "CANONICAL_REVIEW_SOURCE_INVALID");
    if (!Array.isArray(batch.schedule?.source_files) || !batch.schedule.source_files.includes(filename)) {
      fail(`schedule.source_files must include reviewed PDF ${filename}`, "CANONICAL_REVIEW_SOURCE_MISMATCH");
    }
    let reviewedEventCount = 0;
    for (const event of batch.events || []) {
      const eventFile = clean(event?.source?.file_name, 200);
      const declared = sourceHash(event?.source?.file_hash);
      if (eventFile === filename) {
        reviewedEventCount += 1;
        if (declared && declared !== sha) {
          fail("Event source hash does not match reviewed PDF", "CANONICAL_REVIEW_SOURCE_MISMATCH", { group: batch.schedule?.group, actual: declared, expected: sha });
        }
        event.source.file_hash = `sha256:${sha}`;
      } else if (declared && !SHA_RE.test(declared)) {
        fail("Companion source has invalid SHA-256 evidence", "CANONICAL_REVIEW_SOURCE_MISMATCH", { group: batch.schedule?.group, file: eventFile || null });
      }
    }
    if (!reviewedEventCount) {
      fail(`Batch contains no events traced to reviewed PDF ${filename}`, "CANONICAL_REVIEW_SOURCE_MISMATCH", { group: batch.schedule?.group ?? null });
    }
    return { batch, reviewedEventCount };
  }

  function validateOmgmuCanonicalReviewPackage(input, review) {
    if (!review) fail("Parser review not found", "PARSER_REVIEW_NOT_FOUND");
    if (review.university !== "omgmu") fail("Review is not an ОмГМУ review", "CANONICAL_REVIEW_CONTEXT_MISMATCH");
    if (review.status === "PUBLISHED") fail("Published review cannot be replaced", "REVIEW_ALREADY_PUBLISHED");
    if (!input || typeof input !== "object" || Array.isArray(input) || input.format !== FORMAT) fail(`format must be ${FORMAT}`);
    const rulesRevision = clean(input.rules_revision, 120);
    if (!rulesRevision) fail("rules_revision is required");
    if (!Array.isArray(input.batches) || input.batches.length < 1 || input.batches.length > 50) fail("batches must contain 1 to 50 schedule-batch objects");

    const batches = [];
    const groups = new Set();
    const qaReports = [];
    let reviewedEventCount = 0;
    for (const rawBatch of input.batches) {
      const bound = bindReviewedSource(rawBatch, review);
      const context = validateContext(bound.batch, review);
      if (groups.has(context.groupCode)) fail(`Duplicate group batch: ${context.groupCode}`, "CANONICAL_REVIEW_GROUPS_INVALID");
      groups.add(context.groupCode);
      const qa = validateScheduleBatch(bound.batch);
      if (!qa.publishable) {
        fail(`Group ${context.groupCode} canonical batch failed QA`, "CANONICAL_REVIEW_QA_FAILED", { group: context.groupCode, errors: qa.errors, warnings: qa.warnings });
      }
      reviewedEventCount += bound.reviewedEventCount;
      batches.push(bound.batch);
      qaReports.push({ group: context.groupCode, ...qa });
    }

    return {
      format: FORMAT,
      parserType: PARSER_TYPE,
      rulesRevision,
      sourceSha256: clean(review.sourceSha256, 64).toLowerCase(),
      sourceFilename: clean(review.metadata?.filename, 200),
      batches,
      qa: {
        status: "PASS",
        validator: "canonical-schedule-batch-v1",
        groupCount: batches.length,
        eventCount: batches.reduce((sum, batch) => sum + batch.events.length, 0),
        reviewedSourceEventCount: reviewedEventCount,
        groups: [...groups],
        reports: qaReports,
      },
    };
  }

  async function stageOmgmuCanonicalReviewPackage({ input, review, queue }) {
    const normalized = validateOmgmuCanonicalReviewPackage(input, review);
    if (typeof queue?.storeNormalized !== "function") fail("Normalized staging is unavailable", "CANONICAL_REVIEW_STAGING_UNAVAILABLE");
    const normalizedKey = await queue.storeNormalized(review.sourceSha256, normalized);
    return { ...normalized, normalizedKey };
  }

  async function previousFor(scheduleStore, batch) {
    const context = scheduleContext(batch);
    return scheduleStore.getSchedule({
      university: context.university,
      program: context.program,
      course: context.course,
      stream: context.stream,
      groupCode: context.groupCode,
      groupId: context.groupId,
      academicYear: context.academicYear,
      semester: context.semester,
      plan: "semester",
    });
  }

  async function publishStagedOmgmuCanonicalReview({ queue, scheduleStore, review, now }) {
    if (!review?.normalizedKey || review?.qa?.status !== "PASS" || review?.parserType !== PARSER_TYPE || review?.normalizer?.format !== FORMAT) {
      fail("ОмГМУ canonical review is not publishable", "REVIEW_NOT_PUBLISHABLE");
    }
    const normalized = await queue.getNormalized(review.normalizedKey);
    if (!normalized || normalized.parserType !== PARSER_TYPE || normalized.sourceSha256 !== review.sourceSha256 || normalized.qa?.status !== "PASS") {
      fail("Canonical normalized result does not match source review", "NORMALIZED_RESULT_INVALID");
    }
    if (typeof scheduleStore?.getSchedule !== "function" || typeof scheduleStore?.putSchedule !== "function") fail("Schedule store unavailable", "CANONICAL_PUBLICATION_UNAVAILABLE");

    const prepared = [];
    for (const batch of normalized.batches || []) {
      const previous = await previousFor(scheduleStore, batch);
      prepared.push(prepareSchedulePublication(batch, {
        previousBatch: previous?.schema_version === "1.0" && previous?.schedule && Array.isArray(previous?.events) ? previous : null,
        now,
      }));
    }

    const publications = [];
    try {
      for (const item of prepared) {
        const publication = await scheduleStore.putSchedule(item.batch);
        publications.push({
          group: item.context.groupCode,
          scheduleVersionId: item.batch.schedule.schedule_version_id,
          previousScheduleVersionId: item.batch.schedule.previous_schedule_version_id,
          contentFingerprint: item.batch.schedule.content_fingerprint,
          diff: item.diff,
          publication,
        });
      }
    } catch (error) {
      const wrapped = new Error(`ОмГМУ canonical publication stopped after ${publications.length} group(s): ${error?.message || error}`);
      wrapped.code = "CANONICAL_PUBLICATION_PARTIAL";
      wrapped.cause = error;
      wrapped.details = { publishedGroups: publications.map((item) => item.group) };
      throw wrapped;
    }

    return {
      groupCount: publications.length,
      eventCount: prepared.reduce((sum, item) => sum + item.batch.events.length, 0),
      groups: publications.map((item) => item.group),
      publications,
    };
  }

  return Object.freeze({
    validateOmgmuCanonicalReviewPackage,
    stageOmgmuCanonicalReviewPackage,
    publishStagedOmgmuCanonicalReview,
  });
}

export { FORMAT as OMGMU_CANONICAL_REVIEW_FORMAT, PARSER_TYPE as OMGMU_CANONICAL_REVIEW_PARSER_TYPE };
