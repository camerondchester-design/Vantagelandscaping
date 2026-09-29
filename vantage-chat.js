/* Vantage Landscaping website chat widget.
 *
 * Install: drop this file in the site's publish directory (e.g. site root)
 * and add this before </body> on every page:
 *
 *   <script src="/vantage-chat.js" data-api="/.netlify/functions/chat"></script>
 *
 * The data-api attribute is optional; it defaults to /.netlify/functions/chat.
 * No dependencies. No visitor login required.
 */
(function () {
  var API = (document.currentScript && document.currentScript.getAttribute("data-api")) || "/.netlify/functions/chat";
  var SID_KEY = "vantage_chat_sid";
  var POLL_MS = 4000;

  function sid() {
    var s = null;
    try { s = localStorage.getItem(SID_KEY); } catch (e) {}
    if (!s) {
      s = "xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx".replace(/x/g, function () {
        return Math.floor(Math.random() * 16).toString(16);
      });
      try { localStorage.setItem(SID_KEY, s); } catch (e) {}
    }
    return s;
  }
  var sessionId = sid();
  var lastSeen = 0;
  var pollTimer = null;
  var welcomed = false;

  var css = [
    "#vchat-btn{position:fixed;bottom:22px;right:22px;width:60px;height:60px;border-radius:50%;",
    "background:#2e7d32;border:none;cursor:pointer;z-index:999998;box-shadow:0 4px 14px rgba(0,0,0,.25);",
    "display:flex;align-items:center;justify-content:center}",
    "#vchat-btn svg{width:30px;height:30px;fill:#fff}",
    "#vchat-panel{position:fixed;bottom:96px;right:22px;width:380px;max-width:calc(100vw - 44px);",
    "height:540px;max-height:calc(100vh - 130px);background:#fff;border-radius:16px;z-index:999999;",
    "box-shadow:0 8px 30px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    "#vchat-panel.open{display:flex}",
    "#vchat-head{background:#2e7d32;color:#fff;padding:14px 16px}",
    "#vchat-head b{font-size:16px;display:block}",
    "#vchat-head span{font-size:12px;opacity:.85}",
    "#vchat-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f7f7f5}",
    ".vchat-row{display:flex}",
    ".vchat-row.me{justify-content:flex-end}",
    ".vchat-b{max-width:80%;padding:10px 14px;border-radius:16px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-break:break-word}",
    ".vchat-row.me .vchat-b{background:#2e7d32;color:#fff;border-bottom-right-radius:4px}",
    ".vchat-row.them .vchat-b{background:#fff;color:#222;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.08)}",
    ".vchat-sys{align-self:center;font-size:12px;color:#888;font-style:italic}",
    ".vchat-typing{align-self:flex-start;background:#fff;border-radius:16px;padding:10px 14px;box-shadow:0 1px 2px rgba(0,0,0,.08)}",
    ".vchat-typing i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#bbb;margin:0 2px;animation:vt 1s infinite}",
    ".vchat-typing i:nth-child(2){animation-delay:.15s}.vchat-typing i:nth-child(3){animation-delay:.3s}",
    "@keyframes vt{0%,100%{opacity:.3}50%{opacity:1}}",
    "#vchat-form{display:flex;border-top:1px solid #eee;padding:10px}",
    "#vchat-in{flex:1;border:1px solid #ddd;border-radius:20px;padding:10px 14px;font-size:14px;outline:none}",
    "#vchat-send{background:#2e7d32;color:#fff;border:none;border-radius:20px;padding:0 18px;margin-left:8px;font-size:14px;cursor:pointer}"
  ].join("");

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.id = "vchat-btn";
  btn.setAttribute("aria-label", "Chat with Vantage Landscaping");
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>';
  document.body.appendChild(btn);

  var panel = document.createElement("div");
  panel.id = "vchat-panel";
  panel.innerHTML =
    '<div id="vchat-head"><b>Vantage Landscaping</b><span>Typically replies in a couple minutes</span></div>' +
    '<div id="vchat-msgs"></div>' +
    '<form id="vchat-form"><input id="vchat-in" type="text" placeholder="Ask about sod or fence…" autocomplete="off" maxlength="1500"/>' +
    '<button id="vchat-send" type="submit">Send</button></form>';
  document.body.appendChild(panel);

  var msgs = panel.querySelector("#vchat-msgs");
  var form = panel.querySelector("#vchat-form");
  var input = panel.querySelector("#vchat-in");

  function addMsg(text, who) {
    var row = document.createElement("div");
    if (who === "sys") {
      row.className = "vchat-sys";
      row.textContent = text;
      row.dataset.sys = "1";
    } else {
      row.className = "vchat-row " + (who === "me" ? "me" : "them");
      var b = document.createElement("div");
      b.className = "vchat-b";
      b.textContent = text;
      row.appendChild(b);
    }
    msgs.appendChild(row);
    msgs.scrollTop = msgs.scrollHeight;
    return row;
  }

  function showTyping() {
    hideTyping();
    var t = document.createElement("div");
    t.className = "vchat-typing";
    t.id = "vchat-typing";
    t.innerHTML = "<i></i><i></i><i></i>";
    msgs.appendChild(t);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function hideTyping() {
    var t = document.getElementById("vchat-typing");
    if (t) t.remove();
  }
  function clearSys() {
    msgs.querySelectorAll("[data-sys]").forEach(function (el) { el.remove(); });
  }

  function welcome() {
    if (welcomed) return;
    welcomed = true;
    addMsg("Hey, this is Cameron with Vantage Landscaping. Looking for sod or a fence? I can get you a price real quick.", "them");
  }

  btn.addEventListener("click", function () {
    var open = panel.classList.toggle("open");
    if (open) {
      welcome();
      startPoll();
      setTimeout(function () { input.focus(); }, 100);
    } else {
      stopPoll();
    }
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    addMsg(text, "me");
    fetch(API + "/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, text: text, page_url: location.href })
    }).catch(function () {});
    clearSys();
    addMsg("Got it — one sec while I pull that together.", "sys");
    showTyping();
  });

  function poll() {
    fetch(API + "/poll?session_id=" + encodeURIComponent(sessionId) + "&after=" + lastSeen)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        (data.messages || []).forEach(function (m) {
          if (m.id > lastSeen) lastSeen = m.id;
          hideTyping();
          clearSys();
          addMsg(m.text, "them");
        });
      })
      .catch(function () {});
  }
  function startPoll() {
    stopPoll();
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }
  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
})();
