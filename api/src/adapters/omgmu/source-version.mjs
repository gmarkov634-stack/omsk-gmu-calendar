import { createHash } from "node:crypto";

export function buildOmgmuSourceIdentity({ sourcePage, url, sha256 }) {
  if (!sourcePage || !url || !sha256) throw new Error("sourcePage, url and sha256 are required");
  return `${sourcePage}\n${url}\n${sha256}`;
}

export function buildOmgmuSourceKey(input) {
  return createHash("sha256").update(buildOmgmuSourceIdentity(input)).digest("hex");
}

function downloadedFiles(report) {
  if (!report || report.university !== "omgmu" || !Array.isArray(report.files)) {
    throw new Error("Invalid ОмГМУ download report");
  }
  return report.files.filter((item) => item.status === "downloaded" && item.url && item.sha256);
}

export function buildOmgmuSourceSnapshot({ sourcePage, downloadReport }) {
  if (!sourcePage) throw new Error("sourcePage is required");
  const sources = downloadedFiles(downloadReport)
    .map((item) => ({
      sourcePage,
      url: item.url,
      sha256: item.sha256,
      sourceKey: buildOmgmuSourceKey({ sourcePage, url: item.url, sha256: item.sha256 }),
      program: item.program || null,
      course: item.course || null,
      stream: item.stream || null,
      part: item.part || "combined",
      filename: item.filename || null,
      bytes: item.bytes || null,
    }))
    .sort((a, b) => a.url.localeCompare(b.url));

  return {
    version: 1,
    university: "omgmu",
    sourcePage,
    capturedAt: downloadReport.downloadedAt || new Date().toISOString(),
    sourceCount: sources.length,
    sources,
  };
}

export function compareOmgmuSourceSnapshots(previousSnapshot, currentSnapshot) {
  if (!currentSnapshot || currentSnapshot.university !== "omgmu" || !Array.isArray(currentSnapshot.sources)) {
    throw new Error("Invalid current ОмГМУ source snapshot");
  }
  const previousSources = Array.isArray(previousSnapshot?.sources) ? previousSnapshot.sources : [];
  const previousByUrl = new Map(previousSources.map((item) => [item.url, item]));
  const currentByUrl = new Map(currentSnapshot.sources.map((item) => [item.url, item]));

  const added = [];
  const changed = [];
  const unchanged = [];
  const missing = [];

  for (const current of currentSnapshot.sources) {
    const previous = previousByUrl.get(current.url);
    if (!previous) added.push(current);
    else if (previous.sha256 !== current.sha256) changed.push({ before: previous, after: current });
    else unchanged.push(current);
  }

  for (const previous of previousSources) {
    if (!currentByUrl.has(previous.url)) missing.push(previous);
  }

  return {
    version: 1,
    university: "omgmu",
    comparedAt: currentSnapshot.capturedAt || new Date().toISOString(),
    added,
    changed,
    unchanged,
    missing,
    candidateCount: added.length + changed.length,
    hasCandidates: added.length + changed.length > 0,
    // Missing URLs are diagnostic only. They never represent schedule deletion.
    hasMissingSources: missing.length > 0,
    publicationAction: added.length + changed.length > 0 ? "review-required" : "none",
  };
}
