import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { runOmgmuSourceAdapter } from "../src/adapters/omgmu/source-adapter.mjs";

const sourcePage = "https://example.test/schedule";
const pdfUrl = "https://example.test/files/1.pdf";
const html = `<h2>Расписание учебных занятий 2026/2027 осенний семестр</h2><a href="${pdfUrl}">1 курс леч</a>`;
const pdfA = Buffer.from("%PDF-1.7\nA");
const pdfB = Buffer.from("%PDF-1.7\nB");

function response(body, { status = 200 } = {}) {
  return new Response(body, { status });
}

function fetchWithPdf(pdfBuffer) {
  return async (url) => {
    if (url === sourcePage) return response(html);
    if (url === pdfUrl) return response(pdfBuffer);
    return response("not found", { status: 404 });
  };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "omgmu-source-adapter-"));
}

test("first successful source capture requires review, never publish", async () => {
  const result = await runOmgmuSourceAdapter({
    sourceUrl: sourcePage,
    outputDir: await tempDir(),
    fetchFn: fetchWithPdf(pdfA),
  });
  assert.equal(result.status, "review-required");
  assert.equal(result.publishable, false);
  assert.equal(result.diff.added.length, 1);
  assert.equal(result.diff.changed.length, 0);
});

test("identical snapshot is unchanged", async () => {
  const first = await runOmgmuSourceAdapter({
    sourceUrl: sourcePage,
    outputDir: await tempDir(),
    fetchFn: fetchWithPdf(pdfA),
  });
  const second = await runOmgmuSourceAdapter({
    sourceUrl: sourcePage,
    outputDir: await tempDir(),
    previousSnapshot: first.snapshot,
    fetchFn: fetchWithPdf(pdfA),
  });
  assert.equal(second.status, "unchanged");
  assert.equal(second.diff.candidateCount, 0);
  assert.equal(second.publicationAction, "none");
});

test("same URL with changed PDF hash requires review", async () => {
  const first = await runOmgmuSourceAdapter({
    sourceUrl: sourcePage,
    outputDir: await tempDir(),
    fetchFn: fetchWithPdf(pdfA),
  });
  const changed = await runOmgmuSourceAdapter({
    sourceUrl: sourcePage,
    outputDir: await tempDir(),
    previousSnapshot: first.snapshot,
    fetchFn: fetchWithPdf(pdfB),
  });
  assert.equal(changed.status, "review-required");
  assert.equal(changed.diff.added.length, 0);
  assert.equal(changed.diff.changed.length, 1);
  assert.equal(changed.publishable, false);
});

test("download failure is fail-closed and cannot create deletion", async () => {
  const first = await runOmgmuSourceAdapter({
    sourceUrl: sourcePage,
    outputDir: await tempDir(),
    fetchFn: fetchWithPdf(pdfA),
  });
  const failingFetch = async (url) => {
    if (url === sourcePage) return response(html);
    return response("gone", { status: 404 });
  };
  const failed = await runOmgmuSourceAdapter({
    sourceUrl: sourcePage,
    outputDir: await tempDir(),
    previousSnapshot: first.snapshot,
    fetchFn: failingFetch,
  });
  assert.equal(failed.status, "source-error");
  assert.equal(failed.publishable, false);
  assert.equal(failed.publicationAction, "none");
  assert.equal(failed.snapshot, null);
  assert.equal(failed.diff, null);
});
