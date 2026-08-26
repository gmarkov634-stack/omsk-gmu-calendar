import fs from "node:fs/promises";
import path from "node:path";

import { parseExpectedCurrentVersion, publishCanonicalBatch } from "../src/publisher/core-publisher.mjs";

const EXPECTED_PUBLISHER_ORIGIN = "https://medical-calendar-core-omgmu-publisher.containerapps.ru";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const input = arg("input");
const output = arg("output", "data/imports/omgmu-production-publish/report.json");
const expectedRaw = arg("expected-current-version");
if (!input) throw new Error("--input is required");
if (expectedRaw == null) throw new Error("--expected-current-version is required (use none for initial publication)");

const apiUrl = String(process.env.OMGMU_PRODUCTION_PUBLISHER_API_URL || "").replace(/\/+$/, "");
if (apiUrl !== EXPECTED_PUBLISHER_ORIGIN) {
  throw new Error(`OMGMU_PRODUCTION_PUBLISHER_API_URL must be exactly ${EXPECTED_PUBLISHER_ORIGIN}`);
}
const token = process.env.OMGMU_PRODUCTION_SCHEDULE_PUBLISH_TOKEN;
const batch = JSON.parse(await fs.readFile(path.resolve(input), "utf8"));
const expectedCurrentVersionId = parseExpectedCurrentVersion(expectedRaw);
const result = await publishCanonicalBatch({ apiUrl, token, batch, expectedCurrentVersionId });

const report = {
  version: 1,
  boundary: "omgmu-to-medical-calendar-core-production-publish",
  university: "omgmu",
  group: batch.schedule?.group || null,
  sourceFiles: batch.schedule?.source_files || [],
  expectedCurrentVersionId,
  status: result.status,
  scheduleVersionId: result.scheduleVersionId,
  previousScheduleVersionId: result.previousScheduleVersionId ?? null,
  contentFingerprint: result.contentFingerprint,
  eventCount: result.eventCount,
  diff: result.diff,
  publication: result.publication,
  apiOrigin: new URL(apiUrl).origin,
  credentialsIncludedInReport: false,
};
await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
await fs.writeFile(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`OmGMU production core publish: ${report.group} -> ${report.status} ${report.scheduleVersionId}`);
