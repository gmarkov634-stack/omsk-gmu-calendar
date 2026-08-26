import { createHash } from "node:crypto";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function clean(value, limit) {
  const result = String(value ?? "").trim();
  return result ? result.slice(0, limit) : null;
}

export class OmgmuSourceObserver {
  constructor({ queue }) {
    this.queue = queue;
  }

  async observeSource(buffer, input = {}) {
    const bytes = Buffer.from(buffer);
    if (bytes.length < 5 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      const error = new Error("ОмГМУ source is not a PDF");
      error.code = "OMGMU_SOURCE_NOT_PDF";
      throw error;
    }
    const sourceSha256 = sha256(bytes);
    const filename = clean(input.filename, 160) || "schedule.pdf";
    const sourceKey = await this.queue.storeSource(bytes, sourceSha256, filename);
    const metadata = {
      sourcePage: clean(input.sourcePage, 1000),
      sourceUrl: clean(input.sourceUrl, 1000),
      filename,
      label: clean(input.label, 500),
      program: clean(input.program, 80),
      course: Number.isInteger(Number(input.course)) ? Number(input.course) : null,
      stream: clean(input.stream, 20),
      part: clean(input.part, 40) || "combined",
      academicYear: clean(input.academicYear, 20),
      semester: Number(input.semester) === 1 || Number(input.semester) === 2 ? Number(input.semester) : null,
    };
    const review = await this.queue.createReview({
      status: "REVIEW_REQUIRED",
      reason: "SOURCE_REVISION_REQUIRES_CHATGPT_REVIEW",
      parserType: "CHATGPT_REVIEWED_PDF",
      sourceSha256,
      sourceKey,
      metadata,
      classification: {
        type: "SOURCE_OBSERVATION_ONLY",
        confidence: "high",
        reason: "server-pdf-interpretation-disabled",
        features: {
          program: metadata.program,
          course: metadata.course,
          stream: metadata.stream,
          part: metadata.part,
        },
      },
      publicationBlocked: true,
      currentPublishedSchedulePreserved: true,
    });
    return {
      reviewId: review.reviewId,
      status: review.status,
      reason: review.reason,
      sourceSha256,
      sourceKey,
      metadata,
      publicationBlocked: true,
      currentPublishedSchedulePreserved: true,
    };
  }
}
