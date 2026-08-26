const VERSION_ID = /^ver_[A-Za-z0-9_-]+$/;
const OMG_MU_PRODUCTION_PUBLISHER = "https://medical-calendar-core-omgmu-publisher.containerapps.ru";
const FORBIDDEN_API_URLS = new Set([
  "https://kgmu-calendar-api.containerapps.ru",
  "https://kgmu-calendar-tenant-control.containerapps.ru",
  "https://medical-calendar-core-ugmu-test.containerapps.ru",
  "https://medical-calendar-core-ugmu-publisher.containerapps.ru",
]);

function publisherError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function cleanHttpsOrigin(value, label = "publisher API URL") {
  const raw = String(value || "").trim();
  if (!raw) throw publisherError("PUBLISH_CONFIG_INVALID", `${label} is required`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw publisherError("PUBLISH_CONFIG_INVALID", `${label} must be a valid URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw publisherError("PUBLISH_CONFIG_INVALID", `${label} must be a clean HTTPS origin`);
  }
  return url.origin;
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
  return university;
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw publisherError("CORE_PUBLISH_RESPONSE_INVALID", "Core publish response is not JSON", { status: response.status });
  }
}

export async function publishCanonicalBatch({
  apiUrl = OMG_MU_PRODUCTION_PUBLISHER,
  token,
  batch,
  expectedCurrentVersionId,
  fetchFn = fetch,
} = {}) {
  const baseUrl = cleanHttpsOrigin(apiUrl);
  if (baseUrl !== OMG_MU_PRODUCTION_PUBLISHER) {
    if (FORBIDDEN_API_URLS.has(baseUrl)) {
      throw publisherError("PUBLISH_PRODUCTION_URL_FORBIDDEN", "Configured API URL belongs to another runtime/tenant");
    }
    throw publisherError("PUBLISH_ORIGIN_MISMATCH", "OmGMU publisher client is pinned to the dedicated OmGMU production publisher origin");
  }
  if (typeof token !== "string" || token.trim().length < 32) {
    throw publisherError("PUBLISH_TOKEN_MISSING", "A dedicated OmGMU publisher token of at least 32 characters is required");
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
    throw publisherError("CORE_PUBLISH_REJECTED", `Core publish API returned HTTP ${response.status}`, {
      status: response.status,
      response: payload,
    });
  }
  if (!["published", "unchanged"].includes(payload.status) || payload?.context?.university !== "omgmu") {
    throw publisherError("CORE_PUBLISH_RESPONSE_INVALID", "Core publish response did not confirm OmGMU tenant/status", {
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

export const omgmuProductionPublisherBoundary = Object.freeze({
  apiOrigin: OMG_MU_PRODUCTION_PUBLISHER,
  university: "omgmu",
  tokenEnvironmentName: "OMGMU_PRODUCTION_SCHEDULE_PUBLISH_TOKEN",
  schedulePublicationEnabledByRepository: false,
});
