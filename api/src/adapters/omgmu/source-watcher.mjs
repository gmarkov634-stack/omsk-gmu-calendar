import { createHash } from "node:crypto";
import { discoverOmgmuSources, OMG_MU_SOURCE } from "./discover.mjs";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function compactAcademicYear(value) {
  const match = String(value || "").match(/(20\d{2})\s*[\/-]\s*(20)?(\d{2})/);
  return match ? `${match[1]}/${match[3]}` : null;
}

function pageSemester(value) {
  if (value === "autumn") return 1;
  if (value === "spring") return 2;
  return null;
}

function filenameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) || "schedule.pdf");
    return name.toLowerCase().endsWith(".pdf") ? name : "schedule.pdf";
  } catch {
    return "schedule.pdf";
  }
}

function slotKey(source) {
  return [source.program, source.course || "-", source.stream || "-", source.part || "combined"].join(":");
}

function targetPrograms(config) {
  const values = Array.isArray(config.omgmuWatchPrograms) ? config.omgmuWatchPrograms : [];
  return new Set(values.map((value) => String(value).trim()).filter(Boolean));
}

function isPdf(buffer) {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

export class OmgmuSourceWatcher {
  constructor({ config, observer, stateStore, fetchFn = fetch }) {
    this.config = config;
    this.observer = observer;
    this.stateStore = stateStore;
    this.fetch = fetchFn;
    this.running = null;
  }

  async run() {
    if (this.running) return this.running;
    this.running = this.#runOnce().finally(() => { this.running = null; });
    return this.running;
  }

  async #runOnce() {
    if (typeof this.observer?.observeSource !== "function") throw new Error("ОмГМУ source observer is unavailable");
    const state = await this.stateStore.read();
    const sourcePage = this.config.omgmuSchedulePage || OMG_MU_SOURCE;
    const expectedAcademicYear = compactAcademicYear(this.config.offerAcademicYear);
    const expectedSemester = Number(this.config.offerSemester);
    const programs = targetPrograms(this.config);
    const maxBytes = Math.max(1024, Number(this.config.omgmuPdfMaxBytes || 25 * 1024 * 1024));
    const errors = [];
    const results = [];
    let manifest;

    try {
      manifest = await discoverOmgmuSources({ sourceUrl: sourcePage, fetchFn: this.fetch });
    } catch (error) {
      errors.push({ sourcePage, error: String(error?.message || error).slice(0, 300) });
      const summary = this.#summary({ expectedAcademicYear, expectedSemester, manifest: null, targets: [], results, errors });
      state.lastRunAt = summary.checkedAt;
      state.lastRunSummary = summary;
      await this.stateStore.write(state);
      return { ...summary, results, errors };
    }

    const observedAcademicYear = compactAcademicYear(manifest.scheduleContext?.academicYear);
    const observedSemester = pageSemester(manifest.scheduleContext?.semester);
    const periodMatches = observedAcademicYear === expectedAcademicYear && observedSemester === expectedSemester;
    const targets = periodMatches
      ? manifest.sources.filter((source) => programs.has(source.program))
      : [];

    if (!periodMatches && manifest.sources.some((source) => programs.has(source.program))) {
      errors.push({
        sourcePage,
        error: `Official ОмГМУ page period ${observedAcademicYear || "unknown"}/${observedSemester || "unknown"} does not match ${expectedAcademicYear}/${expectedSemester}`,
      });
    }

    const seenSlots = new Set();
    for (const source of targets) {
      const key = slotKey(source);
      seenSlots.add(key);
      try {
        const response = await this.fetch(source.url, {
          redirect: "follow",
          headers: { "User-Agent": "medical-calendar-api/1.0 ОмГМУ schedule watcher", Accept: "application/pdf,*/*;q=0.1" },
        });
        if (!response.ok) throw new Error(`PDF HTTP ${response.status}`);
        const declared = Number(response.headers?.get?.("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`PDF exceeds ${maxBytes} bytes`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error(`PDF exceeds ${maxBytes} bytes`);
        if (!isPdf(buffer)) throw new Error("Source response is not PDF");
        const hash = sha256(buffer);
        const previous = state.slots[key];
        if (previous?.sha256 === hash && previous?.url === source.url) {
          state.slots[key] = { ...previous, lastSeenAt: new Date().toISOString(), label: source.label };
          results.push({ slot: key, status: "UNCHANGED", sha256: hash, url: source.url, reviewId: previous.reviewId || null });
          continue;
        }

        const observation = await this.observer.observeSource(buffer, {
          sourcePage,
          sourceUrl: source.url,
          filename: filenameFromUrl(source.url),
          label: source.label,
          program: source.program,
          course: source.course,
          stream: source.stream,
          part: source.part,
          academicYear: expectedAcademicYear,
          semester: expectedSemester,
        });
        state.slots[key] = {
          sha256: hash,
          url: source.url,
          label: source.label,
          program: source.program,
          course: source.course,
          stream: source.stream || null,
          part: source.part || "combined",
          reviewId: observation.reviewId,
          reviewStatus: observation.status,
          firstObservedAt: previous?.firstObservedAt || new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          lastChangedAt: new Date().toISOString(),
        };
        results.push({
          slot: key,
          status: previous ? "CHANGED_REVIEW_REQUIRED" : "NEW_REVIEW_REQUIRED",
          sha256: hash,
          url: source.url,
          reviewId: observation.reviewId,
          publicationBlocked: true,
        });
      } catch (error) {
        errors.push({ slot: key, url: source.url, error: String(error?.message || error).slice(0, 300) });
      }
    }

    for (const [key, previous] of Object.entries(state.slots || {})) {
      if (!seenSlots.has(key) && previous?.sha256) {
        results.push({ slot: key, status: "MISSING_DIAGNOSTIC_ONLY", sha256: previous.sha256, url: previous.url, reviewId: previous.reviewId || null });
      }
    }

    const summary = this.#summary({ expectedAcademicYear, expectedSemester, manifest, targets, results, errors });
    state.lastRunAt = summary.checkedAt;
    state.lastRunSummary = summary;
    await this.stateStore.write(state);
    return { ...summary, results, errors };
  }

  #summary({ expectedAcademicYear, expectedSemester, manifest, targets, results, errors }) {
    return {
      status: errors.length ? "PARTIAL" : "OK",
      checkedAt: new Date().toISOString(),
      expectedAcademicYear,
      expectedSemester,
      observedAcademicYear: compactAcademicYear(manifest?.scheduleContext?.academicYear),
      observedSemester: pageSemester(manifest?.scheduleContext?.semester),
      discoveredCount: manifest?.sources?.length || 0,
      targetCount: targets.length,
      newReviewCount: results.filter((item) => item.status === "NEW_REVIEW_REQUIRED").length,
      changedReviewCount: results.filter((item) => item.status === "CHANGED_REVIEW_REQUIRED").length,
      unchangedCount: results.filter((item) => item.status === "UNCHANGED").length,
      missingCount: results.filter((item) => item.status === "MISSING_DIAGNOSTIC_ONLY").length,
      errorCount: errors.length,
      publicationAction: results.some((item) => /REVIEW_REQUIRED$/.test(item.status)) ? "review-required" : "none",
    };
  }
}
