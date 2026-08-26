const VERSION_ID = /^ver_[A-Za-z0-9_-]+$/;
const FORBIDDEN_DEFAULT_URLS = new Set([
  "https://kgmu-calendar-api.containerapps.ru",
  "https://medical-calendar-core-ugmu-publisher.containerapps.ru",
  "https://medical-calendar-core-ugmu-test.containerapps.ru",
]);

function publisherError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cleanHttpsUrl(value, label = "publisher API URL") {
  const raw = String(value || "").trim();
  if (!raw) throw publisherError("PUBLISH_CONFIG_INVALID", `${label} is required`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw publisherError("PUBLISH_CONFIG_INVALID", `${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw publisherError("PUBLISH_CONFIG_INVALID", `${label} must be a clean HTTPS URL`);
  }
  return url.toString().replace(/\/+$/, "");
}

function expectedVersion(value) {
  if (value === null) return null;
  if (!VERSION_ID.test(String(value || ""))) {
    throw publisherError("PUBLISH_PRECONDITION_INVALID", "expectedCurrentVersionId must be null or ver_...");
  }
  return String(value);
}

function assertBatch(batch) {
  if (!batch || batch.schema_version !== "1.0" || !batch.schedule || !Array.isArray(batch.events)) {
    throw publisherError("PUBLISH_BATCH_INVALID", "Schedule Batch v1 is required");
  }
  const university = String(batch.schedule.university_code || "").trim().toLowerCase();
  if (university !== "omgmu") {
    throw publisherError("PUBLISH_TENANT_MISMATCH", `Batch university ${university || "<missing>"} is not omgmu`);
  }
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw publisherError("CORE_PUBLISH_RESPONSE_INVALID", "Publisher response is not JSON", { status: response.status });
  }
}

export async function publishCanonicalBatch({
  apiUrl,
  token,
  batch,
  expectedCurrentVersionId,
  forbiddenApiUrls = [...FORBIDDEN_DEFAULT_URLS],
  fetchFn = fetch,
} = {}) {
  const baseUrl = cleanHttpsUrl(apiUrl);
  const forbidden = new Set((forbiddenApiUrls || []).map((value) => cleanHttpsUrl(value, "forbidden API URL")));
  if (forbidden.has(baseUrl)) {
    throw publisherError("PUBLISH_PRODUCTION_URL_FORBIDDEN", "The configured publisher API URL is forbidden for OmGMU");
  }
  if (typeof token !== "string" || token.trim().length < 32) {
    throw publisherError("PUBLISH_TOKEN_MISSING", "An OmGMU publisher token of at least 32 characters is required");
  }
  assertBatch(batch);
  const expected = expectedVersion(expectedCurrentVersionId);

  const response = await fetchFn(`${baseUrl}/api/v1/admin/schedules/publish`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.trim()}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ batch, expectedCurrentVersionId: expected }),
  });
  const payload = await responseJson(response);
  if (!response.ok) {
    throw publisherError("CORE_PUBLISH_REJECTED", `Publisher API returned HTTP ${response.status}`, {
      status: response.status,
      response: payload,
    });
  }
  if (!["published", "unchanged"].includes(payload.status) || payload?.context?.university !== "omgmu") {
    throw publisherError("CORE_PUBLISH_RESPONSE_INVALID", "Publisher response did not confirm OmGMU/status", {
      status: response.status,
    });
  }
  return payload;
}

export function parseExpectedCurrentVersion(value) {
  const raw = String(value ?? "").trim();
  if (/^(none|null)$/i.test(raw)) return null;
  return expectedVersion(raw);
}
