import fs from "node:fs/promises";
import { downloadOmgmuSources } from "../src/adapters/omgmu/download.mjs";

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const manifestPath = readArg("manifest", "data/imports/omgmu-source-manifest.json");
const outputDir = readArg("output", "data/imports/omgmu-pdfs");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const report = await downloadOmgmuSources({ manifest, outputDir });

console.log(`Downloaded ${report.downloadedCount}/${report.sourceCount} ОмГМУ PDF files`);
console.log(`Report: ${outputDir}/download-report.json`);
if (report.failedCount) process.exitCode = 2;
