/* Vantage Landscaping website chat backend (Netlify Function).
 *
 * Visitor endpoints (no auth):
 *   POST /.netlify/functions/chat/send   {session_id, text, page_url?}
 *   GET  /.netlify/functions/chat/poll?session_id=..&after=<msg_id>
 *
 * Admin endpoints (Authorization: Bearer <CHAT_ADMIN_KEY>):
 *   GET  /.netlify/functions/chat/admin/pending
 *   POST /.netlify/functions/chat/admin/reply   {session_id, text}
 *
 * Storage: Netlify Blobs store "vantage-chat".
 *   session/<session_id>.json -> {session_id, created_at, page_url, user_agent,
 *                                 messages:[{id, role, text, ts}], replied_up_to}
 *   inbox.json -> { <session_id>: true }  (sessions with unreplied visitor msgs)
 *
 * Requires the @netlify/blobs package in the site's dependencies.
 * Requires the CHAT_ADMIN_KEY environment variable for admin endpoints.
 */

const crypto = require("crypto");

const STORE_NAME = "vantage-chat";
const MAX_TEXT_LEN = 1500;
const MAX_MSGS_PER_SESSION = 200;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 30;

const rateBuckets = new Map(); // ip -> { count, reset }

function getBlobs() {
  // Lazy require so a missing dependency produces a clear error, not a crash.
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

function validSessionId(sid) {
  return typeof sid === "string" && /^[a-fA-F0-9-]{16,64}$/.test(sid);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function checkAdmin(event) {
  const expected = process.env.CHAT_ADMIN_KEY;
  if (!expected) {
    return { ok: false, response: json(503, { error: "Chat not configured yet (missing CHAT_ADMIN_KEY)." }) };
  }
  const h = event.headers || {};
  const got = h.authorization || h.Authorization || "";
  if (!safeEqual(got, "Bearer " + expected)) {
    return { ok: false, response: json(401, { error: "Unauthorized." }) };
  }
  return { ok: true };
}

async function loadSession(store, session_id) {
  const key = "session/" + session_id + ".json";
  const s = await store.get(key, { type: "json" });
  return { key, session: s };
}

async function handleSend(event, store) {
  if (!checkRate(clientIp(event))) return json(429, { error: "Slow down a bit and try again." });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Bad request." });
  }
  const session_id = body.session_id;
  const text = String(body.text || "").trim().slice(0, MAX_TEXT_LEN);
  if (!validSessionId(session_id)) return json(400, { error: "Bad session." });
  if (!text) return json(400, { error: "Empty message." });

  const { key, session } = await loadSession(store, session_id);
  const now = Date.now();
  const s = session || {
    session_id,
    created_at: now,
    page_url: String(body.page_url || "").slice(0, 500),
    user_agent: String((event.headers || {})["user-agent"] || "").slice(0, 300),
    messages: [],
    replied_up_to: 0,
  };
  if (s.messages.length >= MAX_MSGS_PER_SESSION) {
    return json(429, { error: "This chat is full — call or text us instead!" });
  }
  const msg = { id: now, role: "visitor", text, ts: now };
  s.messages.push(msg);
  await store.setJSON(key, s);

  const inbox = (await store.get("inbox", { type: "json" })) || {};
  inbox[session_id] = true;
  await store.setJSON("inbox", inbox);

  return json(200, { ok: true, msg_id: msg.id });
}

async function handlePoll(event, store) {
  const q = event.queryStringParameters || {};
  const session_id = q.session_id;
  const after = Number(q.after || 0);
  if (!validSessionId(session_id)) return json(400, { error: "Bad session." });
  const { session } = await loadSession(store, session_id);
  if (!session) return json(200, { messages: [] });
  const msgs = session.messages.filter(
    (m) => m.role === "assistant" && m.id > after
  );
  return json(200, { messages: msgs });
}

async function handleAdminPending(event, store) {
  const auth = checkAdmin(event);
  if (!auth.ok) return auth.response;
  const inbox = (await store.get("inbox", { type: "json" })) || {};
  const pending = [];
  for (const session_id of Object.keys(inbox)) {
    const { session } = await loadSession(store, session_id);
    if (!session) continue;
    const unreplied = session.messages.filter(
      (m) => m.role === "visitor" && m.id > (session.replied_up_to || 0)
    );
    if (unreplied.length) {
      pending.push({
        session_id,
        created_at: session.created_at,
        page_url: session.page_url,
        messages: unreplied,
        recent: session.messages.slice(-6),
      });
    }
  }
  return json(200, { pending });
}

async function handleAdminReply(event, store) {
  const auth = checkAdmin(event);
  if (!auth.ok) return auth.response;
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Bad request." });
  }
  const session_id = body.session_id;
  const text = String(body.text || "").trim().slice(0, MAX_TEXT_LEN);
  if (!validSessionId(session_id) || !text) return json(400, { error: "Bad request." });

  const { key, session } = await loadSession(store, session_id);
  if (!session) return json(404, { error: "Session not found." });
  const now = Date.now();
  const msg = { id: now, role: "assistant", text, ts: now };
  session.messages.push(msg);
  session.replied_up_to = Math.max(
    session.replied_up_to || 0,
    ...session.messages.filter((m) => m.role === "visitor").map((m) => m.id)
  );
  await store.setJSON(key, session);

  const inbox = (await store.get("inbox", { type: "json" })) || {};
  delete inbox[session_id];
  await store.setJSON("inbox", inbox);

  return json(200, { ok: true, msg_id: msg.id });
}

exports.handler = async (event) => {
  try {
    const { getStore } = getBlobs();
    const store = getStore(STORE_NAME);

    const path = String(event.path || "");
    const suffix = path.replace(/^.*\/\.netlify\/functions\/chat/, "") || "/";

    if (event.httpMethod === "POST" && suffix === "/send") {
      return await handleSend(event, store);
    }
    if (event.httpMethod === "GET" && suffix === "/poll") {
      return await handlePoll(event, store);
    }
    if (event.httpMethod === "GET" && suffix === "/admin/pending") {
      return await handleAdminPending(event, store);
    }
    if (event.httpMethod === "POST" && suffix === "/admin/reply") {
      return await handleAdminReply(event, store);
    }
    if (suffix === "/health") return json(200, { ok: true, status: "Chat backend live." });
    return json(404, { error: "Not found." });
  } catch (e) {
    return json(500, { error: e.message || "Server error." });
  }
};
