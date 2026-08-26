import fs from "node:fs/promises";
import path from "node:path";

export const OMG_MU_SOURCE = "https://omsk-osma.ru/studentam/raspisanie-zanyatiy";

function decodeHtml(value = "") {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value = "") {
  return String(value).toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ").trim();
}

const PROGRAM_CONTEXT_MARKERS = Object.freeze([
  ["medicine-international", ["иностранных граждан", "лечебное дело для иностранных"]],
  ["preventive-medicine", ["медико-профилактическ"]],
  ["pediatrics", ["педиатрическ"]],
  ["dentistry", ["стоматологическ"]],
  ["pharmacy", ["фармацевтическ"]],
  ["public-health", ["общественное здравоохранение"]],
  ["psychology", ["психология"]],
  ["medicine", ["лечебный факультет"]],
]);

function lastProgramContext(value = "") {
  const normalized = normalizeText(value);
  let result = null;
  let resultIndex = -1;
  for (const [program, markers] of PROGRAM_CONTEXT_MARKERS) {
    for (const marker of markers) {
      const index = normalized.lastIndexOf(marker);
      if (index > resultIndex) {
        result = program;
        resultIndex = index;
      }
    }
  }
  return result;
}

function lastCourseContext(value = "") {
  const normalized = normalizeText(value);
  const pattern = /(?:^|\s)([1-6])\s*(?:курс|леч|мед|пед|стом|фарм|год(?:\s+обучения)?)(?=\s|$|[,:;])/g;
  let result = null;
  for (const match of normalized.matchAll(pattern)) result = Number(match[1]);
  return result;
}

function lastStreamContext(value = "") {
  const normalized = normalizeText(value);
  const pattern = /(?:^|\s)([12])\s*поток(?=\s|$|[,:;])/g;
  let result = null;
  for (const match of normalized.matchAll(pattern)) result = match[1];
  return result;
}

function masterProgramFromUrl(url = "") {
  const normalizedUrl = String(url).toLowerCase();
  const match = normalizedUrl.match(/\/magistr\/20\d{2}\/(ozz|psih)\/[^/?#]*_([12])\.pdf(?:$|[?#])/);
  if (!match) return null;
  return {
    program: match[1] === "ozz" ? "public-health" : "psychology",
    course: Number(match[2]),
  };
}

export function extractOmgmuScheduleContext(html) {
  const text = decodeHtml(html);
  const marker = text.toLowerCase().indexOf("расписание учебных занятий");
  const context = marker >= 0 ? text.slice(marker, marker + 700) : text.slice(0, 700);
  const academicYear = context.match(/20\d{2}\s*\/\s*20\d{2}/)?.[0]?.replace(/\s+/g, "") || null;
  const semester = /осенн/i.test(context) ? "autumn" : /весенн/i.test(context) ? "spring" : null;
  return {
    academicYear,
    semester,
    heading: context.slice(0, 320).trim() || null,
  };
}

export function classifyOmgmuLabel(label, url = "") {
  const normalized = normalizeText(label);
  const normalizedUrl = String(url).toLowerCase();
  let course = Number(normalized.match(/(?:^|\s)([1-6])\s*(?:курс|леч|мед|пед|стом|фарм|год(?:\s+обучения)?)/)?.[1] || 0) || null;
  const stream = normalized.match(/([12])\s*поток/)?.[1] || null;

  let part = "combined";
  if (/лекц/.test(normalized)) part = "lectures";
  else if (/цикл/.test(normalized)) part = "cycles";
  else if (/дот|дистанц/.test(normalized)) part = "distance";
  else if (/фронт/.test(normalized)) part = "front";
  else if (/выбор/.test(normalized)) part = "electives";
  else if (/практич/.test(normalized)) part = "practice";

  let program = null;
  if (/иностран/.test(normalized) || /\/bilingva\//.test(normalizedUrl)) program = "medicine-international";
  else if (/обществен.*здравоохран/.test(normalized)) program = "public-health";
  else if (/психолог/.test(normalized)) program = "psychology";
  else if (/леч/.test(normalized)) program = "medicine";
  else if (/(?:^|\s)мед(?:\s|$)/.test(normalized) || /мед.*проф/.test(normalized)) program = "preventive-medicine";
  else if (/пед/.test(normalized)) program = "pediatrics";
  else if (/стом/.test(normalized)) program = "dentistry";
  else if (/фарм/.test(normalized)) program = "pharmacy";

  const masterUrl = masterProgramFromUrl(url);
  if (!program && masterUrl) program = masterUrl.program;
  if (!course && masterUrl) course = masterUrl.course;

  return { program, course, stream, part };
}

export function extractOmgmuSources(html, sourceUrl = OMG_MU_SOURCE) {
  const base = new URL(sourceUrl);
  const links = [];
  const state = { program: null, course: null, stream: null };
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let cursor = 0;

  for (const match of html.matchAll(anchorPattern)) {
    const between = decodeHtml(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const contextProgram = lastProgramContext(between);
    if (contextProgram) {
      state.program = contextProgram;
      state.course = null;
      state.stream = null;
    }
    const contextCourse = lastCourseContext(between);
    if (contextCourse) {
      state.course = contextCourse;
      state.stream = null;
    }
    const contextStream = lastStreamContext(between);
    if (contextStream) state.stream = contextStream;

    const label = decodeHtml(match[2]);
    if (!label) continue;
    let url;
    try { url = new URL(match[1], base).href; } catch { continue; }
    if (!/\.pdf(?:$|[?#])/i.test(url) && !/\/files\//i.test(url)) continue;

    const direct = classifyOmgmuLabel(label, url);
    const program = direct.program || state.program;
    const course = direct.course || state.course;
    const stream = direct.stream || (direct.course ? null : state.stream);
    links.push({ label, url, program, course, stream, part: direct.part });

    if (direct.program && direct.program !== state.program) {
      state.program = direct.program;
      state.course = null;
      state.stream = null;
    }
    if (direct.course) {
      state.course = direct.course;
      state.stream = direct.stream || null;
    } else if (direct.stream) {
      state.stream = direct.stream;
    }
  }
  return links;
}

export function validateOmgmuManifest(manifest) {
  const errors = [];
  const seen = new Set();
  for (const item of manifest.sources) {
    if (seen.has(item.url)) errors.push(`duplicate source: ${item.url}`);
    seen.add(item.url);
    if (!item.program) errors.push(`unclassified program: ${item.label}`);
    if (!item.course) errors.push(`unclassified course: ${item.label}`);
  }
  return errors;
}

export async function discoverOmgmuSources({ sourceUrl = OMG_MU_SOURCE, output, fetchFn = fetch } = {}) {
  const response = await fetchFn(sourceUrl, {
    headers: {
      "User-Agent": "MedicalUniversityCalendarBot/1.0 (+schedule source discovery)",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`ОмГМУ page request failed: ${response.status}`);

  const html = await response.text();
  const sources = extractOmgmuSources(html, sourceUrl);
  const manifest = {
    version: 2,
    university: "omgmu",
    sourcePage: sourceUrl,
    discoveredAt: new Date().toISOString(),
    scheduleContext: extractOmgmuScheduleContext(html),
    sourceCount: sources.length,
    sources,
  };
  const errors = validateOmgmuManifest(manifest);
  manifest.validation = { status: errors.length ? "needs-review" : "ok", errors };

  if (output) {
    const filename = path.resolve(output);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return manifest;
}
