/* Telnyx inbound SMS webhook receiver (Netlify Function).
 *
 * Why this exists: Telnyx has no API to list/receive past SMS messages.
 * The only way to see replies is this webhook: Telnyx POSTs every inbound
 * (and delivery) event here in real time.
 *
 * Endpoints:
 *   POST /.netlify/functions/telnyx-webhook?secret=<TELNYX_WEBHOOK_SECRET>
 *        Telnyx event receiver. Stores inbound SMS + delivery receipts.
 *
 *   GET  /.netlify/functions/telnyx-webhook/admin/inbox
 *        (Authorization: Bearer <CHAT_ADMIN_KEY>) -> unread inbound messages
 *   POST /.netlify/functions/telnyx-webhook/admin/ack   {ids: [...]}
 *        (Authorization: Bearer <CHAT_ADMIN_KEY>) -> mark messages read
 *
 * Storage: Netlify Blobs store "telnyx-inbound".
 *   inbox.json    -> [{id, from, to, text, received_at, read}]
 *   receipts.json -> {<message_id>: {status, updated_at}}  (outbound delivery)
 *
 * Env vars: TELNYX_WEBHOOK_SECRET (shared secret, also embedded in the
 *           webhook URL you paste into the Telnyx messaging profile),
 *           CHAT_ADMIN_KEY (same admin key as the chat function).
 * Requires the @netlify/blobs package in the site's dependencies.
 */

const crypto = require("crypto");

const STORE_NAME = "telnyx-inbound";
const OUR_NUMBER = "+13858321200";
const MAX_INBOX = 500;

function getBlobs() {
  try {
    return require("@netlify/blobs");
  } catch (e) {
    throw new Error(
      "Missing dependency: run `npm install @netlify/blobs` in the site and redeploy."
    );
  }
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function checkSecret(event) {
  const expected = process.env.TELNYX_WEBHOOK_SECRET;
  if (!expected) return false;
  const q = event.queryStringParameters || {};
  return safeEqual(q.secret || "", expected);
}

function checkAdmin(event) {
  const expected = process.env.CHAT_ADMIN_KEY;
  if (!expected) {
    return { ok: false, response: json(503, { error: "Not configured (missing CHAT_ADMIN_KEY)." }) };
  }
  const h = event.headers || {};
  const got = h.authorization || h.Authorization || "";
  if (!safeEqual(got, "Bearer " + expected)) {
    return { ok: false, response: json(401, { error: "Unauthorized." }) };
  }
  return { ok: true };
}

async function handleWebhook(event, store) {
  if (!checkSecret(event)) return json(403, { error: "Bad secret." });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Bad request." });
  }

  const data = body.data || {};
  const type = data.event_type || "";
  const p = data.payload || {};
  const now = Date.now();

  if (type === "message.received") {
    const to = ((p.to || [])[0] || {}).phone_number || "";
    if (to !== OUR_NUMBER) return json(200, { ok: true, skipped: "not our number" });
    const inbox = (await store.get("inbox.json", { type: "json" })) || [];
    inbox.push({
      id: data.id || ("msg-" + now),
      from: (p.from || {}).phone_number || "",
      to,
      text: String(p.text || "").slice(0, 2000),
      received_at: now,
      read: false,
    });
    await store.setJSON("inbox.json", inbox.slice(-MAX_INBOX));
    return json(200, { ok: true });
  }

  if (type === "message.sent" || type === "message.delivered" ||
      type === "message.sending_failed" || type === "message.delivery_failed") {
    const receipts = (await store.get("receipts.json", { type: "json" })) || {};
    receipts[data.id || ("r-" + now)] = {
      status: type.replace("message.", ""),
      updated_at: now,
      to: ((p.to || [])[0] || {}).phone_number || "",
    };
    await store.setJSON("receipts.json", receipts);
    return json(200, { ok: true });
  }

  return json(200, { ok: true, skipped: "unhandled event" });
}

async function handleAdminInbox(event, store) {
  const auth = checkAdmin(event);
  if (!auth.ok) return auth.response;
  const inbox = (await store.get("inbox.json", { type: "json" })) || [];
  return json(200, { messages: inbox.filter((m) => !m.read) });
}

async function handleAdminAck(event, store) {
  const auth = checkAdmin(event);
  if (!auth.ok) return auth.response;
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Bad request." });
  }
  const ids = new Set(body.ids || []);
  const inbox = (await store.get("inbox.json", { type: "json" })) || [];
  for (const m of inbox) if (ids.has(m.id)) m.read = true;
  await store.setJSON("inbox.json", inbox);
  return json(200, { ok: true });
}

exports.handler = async (event) => {
  try {
    const { getStore } = getBlobs();
    const store = getStore(STORE_NAME);
    const path = String(event.path || "");
    const suffix = path.replace(/^.*\/\.netlify\/functions\/telnyx-webhook/, "") || "/";

    if (event.httpMethod === "POST" && (suffix === "/" || suffix === "")) {
      return await handleWebhook(event, store);
    }
    if (event.httpMethod === "GET" && suffix === "/admin/inbox") {
      return await handleAdminInbox(event, store);
    }
    if (event.httpMethod === "POST" && suffix === "/admin/ack") {
      return await handleAdminAck(event, store);
    }
    return json(404, { error: "Not found." });
  } catch (e) {
    return json(500, { error: e.message || "Server error." });
  }
};
