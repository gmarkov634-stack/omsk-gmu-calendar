import fs from "node:fs/promises";
import path from "node:path";
import { detectOmgmuSourceProfile } from "./source-profiles.mjs";

const SOURCE_NAME = /^(\d+)_([^_]+)_course-(\d+)(?:_stream-([^_]+))?_([^.]*)\.txt$/;

function numericSort(a, b) {
  return a.localeCompare(b, "ru", { numeric: true });
}

export function extractGroupCodes(text) {
  const candidates = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/\b(?:2025|2026)\b/.test(line) && !/Дисциплина|Discipline/.test(line)) continue;
    if (/\d{1,2}[.:]\d{2}/.test(line)) continue;
    const codes = [...line.matchAll(/(?<!\d)(\d{3,4})(?!\d)/g)]
      .map((match) => match[1])
      .filter((code) => !["2025", "2026"].includes(code));
    const unique = [...new Set(codes)];
    if (unique.length >= 2) candidates.push(unique);
    else if (unique.length === 1 && /Дисциплина|Discipline|К\.дн\.|N\. of d/i.test(line)) candidates.push(unique);
  }
  if (!candidates.length) return [];
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0].sort(numericSort);
}

export function parseSourceFilename(filename) {
  const match = path.basename(filename).match(SOURCE_NAME);
  if (!match) throw new Error(`Unsupported ОмГМУ source filename: ${filename}`);
  return {
    order: Number(match[1]),
    program: match[2],
    course: Number(match[3]),
    stream: match[4] || null,
    part: match[5] || "combined",
  };
}

export async function buildOmgmuCatalog({ textDir, output } = {}) {
  const entries = await fs.readdir(textDir, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
    const metadata = parseSourceFilename(entry.name);
    const text = await fs.readFile(path.join(textDir, entry.name), "utf8");
    const profile = detectOmgmuSourceProfile(text, { filename: entry.name });
    if (profile.status !== "classified") {
      throw new Error(`ОмГМУ source profile needs review: ${entry.name}; evidence=${JSON.stringify(profile.evidence)}`);
    }
    sources.push({
      ...metadata,
      filename: entry.name,
      groupCodes: extractGroupCodes(text),
      sourceProfile: profile.profile,
      applicableRules: profile.applicableRules,
      profileEvidence: profile.evidence,
    });
  }
  sources.sort((a, b) => a.order - b.order);

  const buckets = new Map();
  for (const source of sources) {
    const key = [source.program, source.course, source.stream || ""].join(":");
    const bucket = buckets.get(key) || {
      program: source.program,
      course: source.course,
      stream: source.stream,
      groupCodes: new Set(),
      parts: new Set(),
      sourceProfiles: new Set(),
      sources: [],
    };
    for (const code of source.groupCodes) bucket.groupCodes.add(code);
    bucket.parts.add(source.part);
    bucket.sourceProfiles.add(source.sourceProfile);
    bucket.sources.push(source.filename);
    buckets.set(key, bucket);
  }

  const groups = [];
  const offerings = [];
  for (const bucket of buckets.values()) {
    const codes = [...bucket.groupCodes].sort(numericSort);
    offerings.push({
      program: bucket.program,
      course: bucket.course,
      stream: bucket.stream,
      parts: [...bucket.parts].sort(),
      sourceProfiles: [...bucket.sourceProfiles].sort(),
      groupCodes: codes,
      sources: bucket.sources,
      sharedParts: codes.length === 0 ? [...bucket.parts].sort() : [],
    });
    for (const code of codes) {
      groups.push({
        id: ["omgmu", bucket.program, bucket.course, bucket.stream ? `stream-${bucket.stream}` : null, code].filter(Boolean).join(":"),
        university: "omgmu",
        program: bucket.program,
        course: bucket.course,
        stream: bucket.stream,
        code,
        displayName: `Группа ${code}`,
        timezone: "Asia/Omsk",
      });
    }
  }
  groups.sort((a, b) => a.course - b.course || numericSort(a.code, b.code));
  offerings.sort((a, b) => a.course - b.course || String(a.stream || "").localeCompare(String(b.stream || "")));

  const catalog = {
    version: 2,
    university: "omgmu",
    timezone: "Asia/Omsk",
    generatedAt: new Date().toISOString(),
    groupCount: groups.length,
    sourceProfileCount: new Set(sources.map((source) => source.sourceProfile)).size,
    groups,
    offerings,
    sources,
  };
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  }
  return catalog;
}
