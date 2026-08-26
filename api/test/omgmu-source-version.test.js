import test from "node:test";
import assert from "node:assert/strict";
import { buildOmgmuSourceSnapshot, compareOmgmuSourceSnapshots } from "../src/adapters/omgmu/source-version.mjs";

const sourcePage = "https://omsk-osma.ru/studentam/raspisanie-zanyatiy";
const makeReport = (files) => ({ university: "omgmu", downloadedAt: "2026-08-14T00:00:00.000Z", files });
const makePdf = (url, sha256) => ({ status: "downloaded", url, sha256, program: "medicine", course: 1, filename: "source.pdf", bytes: 1234 });

test("unchanged source stays unchanged", () => {
  const previous = buildOmgmuSourceSnapshot({ sourcePage, downloadReport: makeReport([makePdf("https://example.test/1.pdf", "aaa")]) });
  const current = buildOmgmuSourceSnapshot({ sourcePage, downloadReport: makeReport([makePdf("https://example.test/1.pdf", "aaa")]) });
  const diff = compareOmgmuSourceSnapshots(previous, current);
  assert.equal(diff.candidateCount, 0);
  assert.equal(diff.unchanged.length, 1);
});

test("same URL with new SHA creates review candidate", () => {
  const previous = buildOmgmuSourceSnapshot({ sourcePage, downloadReport: makeReport([makePdf("https://example.test/1.pdf", "aaa")]) });
  const current = buildOmgmuSourceSnapshot({ sourcePage, downloadReport: makeReport([makePdf("https://example.test/1.pdf", "bbb")]) });
  const diff = compareOmgmuSourceSnapshots(previous, current);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.publicationAction, "review-required");
});

test("new URL creates review candidate", () => {
  const previous = buildOmgmuSourceSnapshot({ sourcePage, downloadReport: makeReport([]) });
  const current = buildOmgmuSourceSnapshot({ sourcePage, downloadReport: makeReport([makePdf("https://example.test/2.pdf", "ccc")]) });
  assert.equal(compareOmgmuSourceSnapshots(previous, current).added.length, 1);
});

test("missing or failed source never means deletion", () => {
  const previous = buildOmgmuSourceSnapshot({ sourcePage, downloadReport: makeReport([makePdf("https://example.test/1.pdf", "aaa")]) });
  const current = buildOmgmuSourceSnapshot({ sourcePage, downloadReport: makeReport([{ status: "failed", url: "https://example.test/1.pdf", error: "HTTP 404" }]) });
  const diff = compareOmgmuSourceSnapshots(previous, current);
  assert.equal(diff.missing.length, 1);
  assert.equal(diff.candidateCount, 0);
  assert.equal(diff.publicationAction, "none");
});
