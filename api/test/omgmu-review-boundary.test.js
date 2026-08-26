import assert from "node:assert/strict";
import test from "node:test";
import { createOmgmuReviewHandler } from "../src/adapters/omgmu/http-handler.mjs";
import { applyApprovedReview, sourceSha256, validateReview } from "../src/adapters/omgmu/manual-review.mjs";

function responseRecorder() {
  return {
    status: null,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(body = null) { this.body = body; },
  };
}

test("manual review remains source-bound and produces tenant-local events", () => {
  const sourceHash = sourceSha256(Buffer.from("omgmu-source"));
  const review = {
    version: 1,
    group: "485",
    sourceSha256: sourceHash,
    status: "approved",
    reviewedBy: "reviewer",
    reviewedAt: "2026-08-26T18:00:00Z",
    events: [{
      title: "Психиатрия",
      start: "2026-09-01T08:20:00+06:00",
      end: "2026-09-01T10:00:00+06:00",
      location: "Кафедра",
    }],
  };

  assert.deepEqual(validateReview(review, { expectedGroup: "485", sourceHash }), { valid: true, errors: [] });
  const schedule = applyApprovedReview({ group: { code: "485" }, events: [] }, review, { sourceHash });
  assert.equal(schedule.events.length, 1);
  assert.equal(schedule.events[0].id, "omgmu-485-manual-1");
  assert.equal(schedule.events[0].sourceType, "manual-review");
  assert.throws(
    () => applyApprovedReview({ group: { code: "485" } }, review, { sourceHash: "changed" }),
    (error) => error?.code === "INVALID_MANUAL_REVIEW" && error?.details?.includes("source-changed"),
  );
});

test("review HTTP handler fails closed without admin configuration", async () => {
  const response = responseRecorder();
  const handler = createOmgmuReviewHandler({ queue: {}, watcher: {}, config: {} });
  await handler({ method: "GET", headers: {}, url: "/api/v1/admin/omgmu/parser-reviews" }, response);
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), { error: "admin_not_configured" });
});

test("review HTTP handler delegates an authenticated review list to the injected queue", async () => {
  const token = "x".repeat(32);
  let received = null;
  const queue = {
    async listReviews(options) {
      received = options;
      return [{ id: "review-1" }];
    },
  };
  const response = responseRecorder();
  const handler = createOmgmuReviewHandler({ queue, watcher: {}, config: { adminToken: token } });
  await handler({
    method: "GET",
    headers: { "x-admin-token": token },
    url: "/api/v1/admin/omgmu/parser-reviews?status=PENDING&limit=5",
  }, response);

  assert.equal(response.status, 200);
  assert.deepEqual(received, { status: "PENDING", limit: 5 });
  assert.deepEqual(JSON.parse(response.body), { reviews: [{ id: "review-1" }] });
});
