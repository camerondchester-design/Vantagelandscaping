/* Vantage Landscaping — SMS opt-in backend (Netlify Function)
 *
 * POST /.netlify/functions/sms-optin
 * Body: { full_name, phone, sms_consent: boolean, page_url?, user_agent? }
 *
 * Consent is OPTIONAL: submitting with sms_consent:false succeeds and records
 * NO sms opt-in. Consent must never be forced (10DLC requirement).
 *
 * Storage: Netlify Blobs store "sms-optins"
 *   optin/<e164phone>.json -> { full_name, phone, sms_consent, ts, ip,
 *                               page_url, user_agent, created_at, updated_at }
 *
 * Requires the @netlify/blobs package in the site's dependencies.
 */

const STORE_NAME = "sms-optins";
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

const rateBuckets = new Map();

function getBlobs() {
  try {
    return require("@netlify/blobs");
  } catch (e) {
    throw new Error("Missing dependency: run `npm install @netlify/blobs` in the site and redeploy.");
  }
}

/* Resolve the Blobs store. Prefers Netlify's automatic function context
 * (verified working in production); falls back to explicit credentials
 * (NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN env vars) when auto-context
 * is unavailable. */
function openStore() {
  const { getStore } = getBlobs();
  try {
    return getStore(STORE_NAME);
  } catch (e) {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (siteID && token) {
      return getStore({ name: STORE_NAME, siteID, token });
    }
    throw e;
  }
}

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "https://vantagelandscapingllc.com",
    },
    body: JSON.stringify(body),
  };
}

function clientIp(event) {
  const h = event.headers || {};
  const fwd = h["x-forwarded-for"] || h["X-Forwarded-For"] || "";
  return String(fwd).split(",")[0].trim() || "unknown";
}

function checkRate(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, b);
  }
  b.count += 1;
  return b.count <= RATE_LIMIT_MAX;
}

/* Normalise a US phone number to E.164 (+1XXXXXXXXXX).
   Returns null if the input can't be parsed as a 10-digit US number. */
function toE164(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  return null;
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "https://vantagelandscapingllc.com",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  const ip = clientIp(event);
  if (!checkRate(ip)) {
    return json(429, { error: "Too many requests. Please wait a moment and try again." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Bad request." });
  }

  const full_name = String(body.full_name || "").trim().slice(0, 120);
  const phone_raw = String(body.phone || "").trim();
  const sms_consent = body.sms_consent;

  if (!full_name) return json(400, { error: "Name is required." });

  const phone = toE164(phone_raw);
  if (!phone) return json(400, { error: "Please enter a valid 10-digit US mobile number." });

  // Consent is optional: must be an explicit boolean, recorded exactly as given.
  // sms_consent:false submits fine and records NO opt-in.
  if (typeof sms_consent !== "boolean") {
    return json(400, { error: "Consent choice is required." });
  }

  try {
    const store = openStore();

    const key = "optin/" + phone.replace("+", "") + ".json";
    const existing = await store.get(key, { type: "json" });

    // Upsert — update timestamp if already opted in
    const record = {
      full_name,
      phone,
      sms_consent: sms_consent === true,
      ts: Date.now(),
      ip,
      page_url: String(body.page_url || "").slice(0, 500),
      user_agent: String(body.user_agent || String((event.headers || {})["user-agent"] || "")).slice(0, 300),
      updated_at: existing ? Date.now() : undefined,
      created_at: existing && existing.created_at ? existing.created_at : Date.now(),
    };

    await store.setJSON(key, record);
    return json(200, { ok: true, sms_consent: record.sms_consent });
  } catch (e) {
    return json(500, { error: e.message || "Server error. Please try again." });
  }
};
