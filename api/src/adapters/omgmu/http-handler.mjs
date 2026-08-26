import { createHash, timingSafeEqual } from "node:crypto";

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendEmpty(response, status = 204) {
  response.writeHead(status, { "Cache-Control": "no-store" });
  response.end();
}

function sendPdf(response, body, filename = "schedule.pdf") {
  const safe = String(filename || "schedule.pdf").replace(/[\r\n]/g, " ").slice(0, 180) || "schedule.pdf";
  response.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="schedule.pdf"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function applyCors(request, response, config) {
  const origin = request.headers.origin;
  const allowedOrigins = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [config.allowedOrigin].filter(Boolean);
  if (origin && allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
}

function adminAllowed(request, config) {
  const actual = request.headers["x-admin-token"];
  const expected = config.adminToken;
  if (typeof actual !== "string" || typeof expected !== "string" || expected.length < 32) return false;
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export function createOmgmuReviewHandler({ queue, watcher, config }) {
  return async function omgmuReviewHandler(request, response) {
    applyCors(request, response, config);
    if (request.method === "OPTIONS") return sendEmpty(response);
    if (!config.adminToken || config.adminToken.length < 32) return send(response, 503, { error: "admin_not_configured" });
    if (!adminAllowed(request, config)) return send(response, 403, { error: "admin_forbidden" });
    const url = new URL(request.url, "http://localhost");

    if (request.method === "POST" && url.pathname === "/api/v1/admin/omgmu/watch") {
      if (typeof watcher?.run !== "function") return send(response, 503, { error: "omgmu_watcher_unavailable" });
      try {
        return send(response, 200, await watcher.run());
      } catch (error) {
        console.error("OMGMU source watcher failed", error);
        return send(response, 503, { error: "omgmu_watch_unavailable" });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/v1/admin/omgmu/parser-reviews") {
      try {
        const reviews = await queue.listReviews({
          status: url.searchParams.get("status") || undefined,
          limit: Number(url.searchParams.get("limit") || 100),
        });
        return send(response, 200, { reviews });
      } catch (error) {
        console.error("OMGMU parser review list failed", error);
        return send(response, 503, { error: "omgmu_parser_reviews_unavailable" });
      }
    }

    const sourceMatch = url.pathname.match(/^\/api\/v1\/admin\/omgmu\/parser-reviews\/([a-f0-9-]{36})\/source$/);
    if (request.method === "GET" && sourceMatch) {
      try {
        const review = await queue.getReview(sourceMatch[1]);
        if (!review) return send(response, 404, { error: "parser_review_not_found" });
        const source = await queue.getSource(review.sourceKey);
        if (!source) return send(response, 404, { error: "parser_review_source_not_found" });
        return sendPdf(response, source, review.metadata?.filename || "schedule.pdf");
      } catch (error) {
        console.error("OMGMU parser review source read failed", error);
        return send(response, 503, { error: "omgmu_parser_review_source_unavailable" });
      }
    }

    const reviewMatch = url.pathname.match(/^\/api\/v1\/admin\/omgmu\/parser-reviews\/([a-f0-9-]{36})$/);
    if (request.method === "GET" && reviewMatch) {
      try {
        const review = await queue.getReview(reviewMatch[1]);
        if (!review) return send(response, 404, { error: "parser_review_not_found" });
        return send(response, 200, review);
      } catch (error) {
        console.error("OMGMU parser review read failed", error);
        return send(response, 503, { error: "omgmu_parser_review_unavailable" });
      }
    }

    return send(response, 404, { error: "not_found" });
  };
}
