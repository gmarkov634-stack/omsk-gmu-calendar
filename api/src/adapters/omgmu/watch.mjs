export function buildOmgmuSourceWatchReport(manifest, config) {
  if (!manifest || manifest.university !== "omgmu" || !Array.isArray(manifest.sources)) {
    throw new Error("Invalid ОмГМУ manifest");
  }
  if (!config || config.university !== "omgmu" || !Array.isArray(config.targetPrograms)) {
    throw new Error("Invalid ОмГМУ source-watch config");
  }

  const byProgram = new Map();
  for (const source of manifest.sources) {
    const key = source.program || "unclassified";
    if (!byProgram.has(key)) byProgram.set(key, []);
    byProgram.get(key).push(source);
  }

  const targetPrograms = config.targetPrograms.map((target) => {
    const sources = byProgram.get(target.program) || [];
    return {
      program: target.program,
      label: target.label,
      available: sources.length > 0,
      sourceCount: sources.length,
      courses: [...new Set(sources.map((item) => item.course).filter(Boolean))].sort((a, b) => a - b),
      sources,
    };
  });

  const availableTargets = targetPrograms.filter((item) => item.available);
  const knownSources = config.knownProgram
    ? (byProgram.get(config.knownProgram.program) || [])
    : [];
  const pageAcademicYear = manifest.scheduleContext?.academicYear || null;
  const pageSemester = manifest.scheduleContext?.semester || null;
  const expectedAcademicYear = config.expectedAcademicYear || null;
  const expectedSemester = config.expectedSemester || null;
  const academicYearMatches = !expectedAcademicYear || pageAcademicYear === expectedAcademicYear;
  const semesterMatches = !expectedSemester || pageSemester === expectedSemester;
  const periodMatches = academicYearMatches && semesterMatches;

  return {
    version: 1,
    university: "omgmu",
    checkedAt: manifest.discoveredAt || new Date().toISOString(),
    sourcePage: manifest.sourcePage,
    expectedAcademicYear,
    expectedSemester,
    pageAcademicYear,
    pageSemester,
    pageHeading: manifest.scheduleContext?.heading || null,
    academicYearMatches,
    semesterMatches,
    periodMatches,
    knownProgram: config.knownProgram
      ? {
          ...config.knownProgram,
          sourceCount: knownSources.length,
          courses: [...new Set(knownSources.map((item) => item.course).filter(Boolean))].sort((a, b) => a - b),
        }
      : null,
    targetPrograms,
    availableTargetCount: availableTargets.length,
    availableTargets: availableTargets.map((item) => item.program),
    hasNewProgramSources: availableTargets.length > 0,
    readyFor2026AutumnIngest: periodMatches && availableTargets.length > 0,
    status: availableTargets.length > 0 ? (periodMatches ? "ready-for-ingest" : "needs-period-review") : "waiting",
  };
}
