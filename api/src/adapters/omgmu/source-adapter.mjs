import { discoverOmgmuSources, OMG_MU_SOURCE } from "./discover.mjs";
import { downloadOmgmuSources } from "./download.mjs";
import { buildOmgmuSourceSnapshot, compareOmgmuSourceSnapshots } from "./source-version.mjs";

export async function runOmgmuSourceAdapter({
  sourceUrl = OMG_MU_SOURCE,
  outputDir,
  previousSnapshot = null,
  fetchFn = fetch,
} = {}) {
  if (!outputDir) throw new Error("outputDir is required");

  let manifest;
  try {
    manifest = await discoverOmgmuSources({ sourceUrl, fetchFn });
  } catch (error) {
    return {
      version: 1,
      university: "omgmu",
      status: "source-error",
      sourcePage: sourceUrl,
      publishable: false,
      publicationAction: "none",
      diagnostics: [{ stage: "discover", error: error.message }],
      manifest: null,
      downloadReport: null,
      snapshot: null,
      diff: null,
    };
  }

  if (manifest.validation?.status !== "ok" || manifest.sourceCount === 0) {
    const errors = [...(manifest.validation?.errors || [])];
    if (manifest.sourceCount === 0) errors.push("no schedule sources discovered");
    return {
      version: 1,
      university: "omgmu",
      status: "needs-source-review",
      sourcePage: sourceUrl,
      publishable: false,
      publicationAction: "none",
      diagnostics: errors.map((error) => ({ stage: "discover", error })),
      manifest,
      downloadReport: null,
      snapshot: null,
      diff: null,
    };
  }

  let downloadReport;
  try {
    downloadReport = await downloadOmgmuSources({ manifest, outputDir, fetchFn });
  } catch (error) {
    return {
      version: 1,
      university: "omgmu",
      status: "source-error",
      sourcePage: sourceUrl,
      publishable: false,
      publicationAction: "none",
      diagnostics: [{ stage: "download", error: error.message }],
      manifest,
      downloadReport: null,
      snapshot: null,
      diff: null,
    };
  }

  const failedDownloads = downloadReport.files.filter((item) => item.status === "failed");
  if (failedDownloads.length) {
    return {
      version: 1,
      university: "omgmu",
      status: "source-error",
      sourcePage: sourceUrl,
      publishable: false,
      publicationAction: "none",
      diagnostics: failedDownloads.map((item) => ({ stage: "download", url: item.url, error: item.error })),
      manifest,
      downloadReport,
      snapshot: null,
      diff: null,
    };
  }

  const snapshot = buildOmgmuSourceSnapshot({ sourcePage: sourceUrl, downloadReport });
  const diff = compareOmgmuSourceSnapshots(previousSnapshot, snapshot);

  return {
    version: 1,
    university: "omgmu",
    status: diff.hasCandidates ? "review-required" : "unchanged",
    sourcePage: sourceUrl,
    publishable: false,
    publicationAction: diff.publicationAction,
    diagnostics: diff.missing.map((item) => ({
      stage: "compare",
      kind: "missing-source",
      url: item.url,
      note: "Diagnostic only; published schedule must remain unchanged.",
    })),
    manifest,
    downloadReport,
    snapshot,
    diff,
  };
}
