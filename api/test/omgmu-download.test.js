import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadOmgmuSources } from "../src/adapters/omgmu/download.mjs";

const manifest = {
  university: "omgmu",
  sources: [
    {
      label: "1 курс 1 поток",
      url: "https://example.test/1.pdf",
      program: "medicine-international",
      course: 1,
      stream: "1",
      part: "combined",
    },
  ],
};

test("downloads and verifies ОмГМУ PDF files", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "omgmu-pdf-"));
  const report = await downloadOmgmuSources({
    manifest,
    outputDir,
    fetchFn: async () => new Response(Buffer.from("%PDF-1.7\nexample"), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }),
  });

  assert.equal(report.downloadedCount, 1);
  assert.equal(report.failedCount, 0);
  assert.match(report.files[0].filename, /medicine-international_course-1_stream-1_combined\.pdf$/);
  assert.match(report.files[0].sha256, /^[a-f0-9]{64}$/);
  const saved = await fs.readFile(path.join(outputDir, report.files[0].filename), "utf8");
  assert.match(saved, /^%PDF-/);
});

test("records non-PDF responses as failures", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "omgmu-pdf-"));
  const report = await downloadOmgmuSources({
    manifest,
    outputDir,
    fetchFn: async () => new Response("html", { status: 200 }),
  });

  assert.equal(report.downloadedCount, 0);
  assert.equal(report.failedCount, 1);
  assert.match(report.files[0].error, /not a PDF/);
});
