import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildQualityReport, inspectSchedule } from "../src/adapters/omgmu/quality.mjs";
import { buildOmgmuSourceWatchReport } from "../src/adapters/omgmu/watch.mjs";
import { OmgmuWatchStore } from "../src/adapters/omgmu/watch-store.mjs";
import { OmgmuSourceWatcher } from "../src/adapters/omgmu/source-watcher.mjs";
import { OmgmuSourceObserver } from "../src/adapters/omgmu/source-observer.mjs";
import { createOmgmuSourceProbeHandler } from "../src/adapters/omgmu/source-probe.mjs";

const boundaryFiles = [
  "quality.mjs",
  "watch.mjs",
  "watch-store.mjs",
  "source-watcher.mjs",
  "source-observer.mjs",
  "source-probe.mjs",
];

test("OmGMU quality boundary validates a clean schedule", () => {
  const schedule = {
    academicYear: "2025-2026",
    semester: 2,
    group: { code: "101" },
    events: [{
      id: "101-1",
      title: "Анатомия",
      start: "2026-02-02T09:00:00+06:00",
      end: "2026-02-02T10:30:00+06:00",
      location: "",
    }],
  };

  const inspected = inspectSchedule(schedule);
  assert.equal(inspected.errors.length, 0);
  const report = buildQualityReport([schedule]);
  assert.equal(report.scheduleCount, 1);
  assert.equal(report.eventCount, 1);
  assert.equal(report.errorCount, 0);
});

test("OmGMU watch report gates ingest by target program and period", () => {
  const manifest = {
    university: "omgmu",
    discoveredAt: "2026-08-26T00:00:00.000Z",
    sourcePage: "https://omsk-osma.ru/raspisanie-zanyatij-2/",
    scheduleContext: { academicYear: "2026/2027", semester: "autumn", heading: "Расписание" },
    sources: [{ program: "medicine", course: 1, url: "https://omsk-osma.ru/example.pdf" }],
  };
  const config = {
    university: "omgmu",
    expectedAcademicYear: "2026/2027",
    expectedSemester: "autumn",
    targetPrograms: [{ program: "medicine", label: "Лечебное дело" }],
  };

  const report = buildOmgmuSourceWatchReport(manifest, config);
  assert.equal(report.periodMatches, true);
  assert.equal(report.availableTargetCount, 1);
  assert.equal(report.readyFor2026AutumnIngest, true);
  assert.equal(report.status, "ready-for-ingest");
});

test("OmGMU watch store works with local fallback", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omgmu-watch-store-"));
  try {
    const store = new OmgmuWatchStore({ dataDir, accessKeyId: "", secretAccessKey: "" });
    const initial = await store.read();
    assert.equal(initial.university, "omgmu");
    assert.deepEqual(initial.slots, {});

    await store.write({
      lastRunAt: "2026-08-26T00:00:00.000Z",
      slots: { "medicine:1:-:combined": { sha256: "abc" } },
    });
    const persisted = await store.read();
    assert.equal(persisted.lastRunAt, "2026-08-26T00:00:00.000Z");
    assert.equal(persisted.slots["medicine:1:-:combined"].sha256, "abc");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("OmGMU source observer creates review-only observation", async () => {
  const queue = {
    async storeSource() { return "sources/omgmu/example.pdf"; },
    async createReview(input) {
      assert.equal(input.publicationBlocked, true);
      assert.equal(input.currentPublishedSchedulePreserved, true);
      return { reviewId: "review-1", status: input.status, reason: input.reason };
    },
  };
  const observer = new OmgmuSourceObserver({ queue });
  const result = await observer.observeSource(Buffer.from("%PDF-1.4\nfixture"), {
    filename: "schedule.pdf",
    program: "medicine",
    course: 1,
    academicYear: "2026/27",
    semester: 1,
  });
  assert.equal(result.reviewId, "review-1");
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.publicationBlocked, true);

  await assert.rejects(
    observer.observeSource(Buffer.from("not-a-pdf")),
    (error) => error?.code === "OMGMU_SOURCE_NOT_PDF",
  );
});

test("OmGMU source probe allows only official HTTPS hosts and reports PDF metadata", async () => {
  const pdf = Buffer.from("%PDF-1.4\nfixture");
  let fetchCalls = 0;
  const handler = createOmgmuSourceProbeHandler({
    fetchFn: async (url) => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        url: url.toString(),
        headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/pdf" : null },
        arrayBuffer: async () => pdf,
      };
    },
  });

  function responseCapture() {
    let body = "";
    return {
      response: {
        statusCode: 0,
        headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        end(value = "") { body = Buffer.isBuffer(value) ? value.toString("utf8") : String(value); },
      },
      body: () => body,
    };
  }

  const blocked = responseCapture();
  await handler({ method: "GET", url: "/?url=https%3A%2F%2Fexample.com%2Fschedule.pdf" }, blocked.response);
  assert.equal(blocked.response.statusCode, 400);
  assert.equal(JSON.parse(blocked.body()).error, "source_not_allowed");
  assert.equal(fetchCalls, 0);

  const allowed = responseCapture();
  await handler({ method: "GET", url: "/?url=https%3A%2F%2Fomsk-osma.ru%2Fschedule.pdf" }, allowed.response);
  assert.equal(allowed.response.statusCode, 200);
  const payload = JSON.parse(allowed.body());
  assert.equal(payload.status, "ok");
  assert.equal(payload.isPdf, true);
  assert.equal(fetchCalls, 1);
});

test("OmGMU source watcher is importable without starting network activity", () => {
  const watcher = new OmgmuSourceWatcher({
    config: {},
    observer: {},
    stateStore: {},
    fetchFn: async () => { throw new Error("network must not run in constructor"); },
  });
  assert.equal(typeof watcher.run, "function");
});

test("OmGMU QA/watch boundary has no customer/composition imports", async () => {
  for (const filename of boundaryFiles) {
    const source = await fs.readFile(new URL(`../src/adapters/omgmu/${filename}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /order-context|server-core-customer-runtime|medical-calendar-core/);
  }
});
