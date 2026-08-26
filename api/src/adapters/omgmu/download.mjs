import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

function safePart(value) {
  return String(value ?? "none").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function sourceFilename(source, index) {
  return [
    String(index + 1).padStart(2, "0"),
    safePart(source.program),
    `course-${safePart(source.course)}`,
    source.stream ? `stream-${safePart(source.stream)}` : null,
    safePart(source.part || "combined"),
  ].filter(Boolean).join("_") + ".pdf";
}

function isPdf(buffer) {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

export async function downloadOmgmuSources({ manifest, outputDir, fetchFn = fetch } = {}) {
  if (!manifest || manifest.university !== "omgmu" || !Array.isArray(manifest.sources)) {
    throw new Error("Invalid ОмГМУ manifest");
  }
  if (!outputDir) throw new Error("Output directory is required");

  const directory = path.resolve(outputDir);
  await fs.mkdir(directory, { recursive: true });
  const results = [];

  for (const [index, source] of manifest.sources.entries()) {
    const filename = sourceFilename(source, index);
    const target = path.join(directory, filename);
    try {
      const response = await fetchFn(source.url, {
        headers: {
          "User-Agent": "MedicalUniversityCalendarBot/1.0 (+schedule source download)",
          Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
        },
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!isPdf(buffer)) throw new Error("Response is not a PDF");
      await fs.writeFile(target, buffer);
      results.push({
        ...source,
        status: "downloaded",
        filename,
        bytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      });
    } catch (error) {
      results.push({
        ...source,
        status: "failed",
        filename,
        error: error.message,
      });
    }
  }

  const report = {
    version: 1,
    university: "omgmu",
    downloadedAt: new Date().toISOString(),
    sourceCount: manifest.sources.length,
    downloadedCount: results.filter((item) => item.status === "downloaded").length,
    failedCount: results.filter((item) => item.status === "failed").length,
    files: results,
  };
  await fs.writeFile(path.join(directory, "download-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
