import { buildOmgmuCanonicalBatch } from "./canonical.mjs";
import { parseFourthCourseLectures } from "./fourth-parser.mjs";

/**
 * Profile adapter for `course_lecture_list`.
 *
 * Source interpretation remains inside the profile parser. This function only
 * composes its evidence-rich source series with the common ОмГМУ canonical
 * boundary. Academic/group/source metadata must be supplied by orchestration;
 * nothing is hardcoded here.
 */
export function buildCourseLectureListCanonicalBatch(text, { metadata, source } = {}) {
  const series = parseFourthCourseLectures(text);
  if (series.length === 0) {
    const error = new Error("course_lecture_list produced no Russian lecture source series");
    error.code = "OMG_COURSE_LECTURE_LIST_EMPTY";
    throw error;
  }

  return buildOmgmuCanonicalBatch({
    metadata: {
      ...metadata,
      parser: metadata?.parser || "omgmu-course-lecture-list/o01-o72",
    },
    source,
    series,
  });
}
