/**
 * Sensor diagnostics page (served at GET /diag by diagnostics.ts).
 *
 * Shipped as a string rather than a static file on purpose: the Dockerfile
 * copies only `dist/` from the server build, so a loose .html in src/ would
 * never reach production. Self-contained — no bundler, no external assets.
 *
 * The inline script deliberately uses string concatenation instead of template
 * literals: this whole document lives inside a TS template literal, and a
 * nested backtick or "${" would terminate it or interpolate at build time.
 */
export const DIAG_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Sensor Diagnostics</title>
<style>
  :root {
    --bg: #1a1a2e; --card: #16213e; --border: #1e2f50; --hover: #2e4270;
    --text: #e0e0e0; --dim: #7a8ba8; --cyan: #00d4ff; --blue: #4a9eff;
    --yellow: #ffc107; --orange: #ff9800; --red: #ff5252; --green: #4caf50;
    --purple: #b388ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text); font-size: 14px;
    font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 1280px; margin: 0 auto; padding: 18px 16px 64px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: .02em; }
  h2 {
    font-size: 13px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .09em; color: var(--dim); margin: 28px 0 10px;
  }
  .mono { font-family: "SF Mono", "Cascadia Code", Consolas, monospace; }
  .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .sub { color: var(--dim); font-size: 12px; }
  button {
    background: var(--card); color: var(--text); border: 1px solid var(--border);
    border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 12px; cursor: pointer;
  }
  button:hover { border-color: var(--hover); }
  button[data-on="1"] { border-color: var(--cyan); color: var(--cyan); }

  .strip { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill {
    display: flex; align-items: center; gap: 7px; background: var(--card);
    border: 1px solid var(--border); border-radius: 999px; padding: 6px 13px; font-size: 12px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .ok { background: var(--green); box-shadow: 0 0 8px rgba(76,175,80,.6); }
  .warn { background: var(--yellow); box-shadow: 0 0 8px rgba(255,193,7,.6); }
  .bad { background: var(--red); box-shadow: 0 0 8px rgba(255,82,82,.6); }
  .off { background: #55617a; }

  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 14px; padding: 16px;
  }
  .grid { display: grid; gap: 12px; }
  .g2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .g4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  @media (max-width: 760px) { .g2, .g4 { grid-template-columns: minmax(0, 1fr); } }

  .verdict { border-radius: 14px; padding: 14px 16px; border: 1px solid; margin-bottom: 12px; }
  .verdict b { display: block; font-size: 15px; margin-bottom: 3px; letter-spacing: .01em; }
  .v-bad { border-color: rgba(255,82,82,.55); background: rgba(255,82,82,.10); color: #ffd3d3; }
  .v-ok { border-color: rgba(76,175,80,.55); background: rgba(76,175,80,.10); color: #d3f2d5; }
  .v-idle { border-color: rgba(255,193,7,.5); background: rgba(255,193,7,.09); color: #ffe9b0; }
  .v-none { border-color: var(--border); background: rgba(122,139,168,.08); color: var(--dim); }

  .port-title { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
  .port-title span:first-child { font-size: 15px; font-weight: 600; letter-spacing: .04em; }
  .port-a span:first-child { color: var(--cyan); }
  .port-b span:first-child { color: var(--orange); }
  .port-dead { border-color: rgba(255,82,82,.5); }
  .big { font-size: 30px; font-weight: 600; line-height: 1.15; letter-spacing: -.01em; }
  .big small { font-size: 14px; font-weight: 400; color: var(--dim); margin-left: 4px; }
  .zero { color: var(--red); }
  .live { color: var(--green); }
  .stale { color: var(--dim); }
  .stale-tag {
    display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 999px;
    background: rgba(255,193,7,.14); color: var(--yellow); font-size: 11px; vertical-align: middle;
  }

  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 6px 10px 6px 0; vertical-align: top; }
  th { color: var(--dim); font-weight: 500; }
  tr + tr td { border-top: 1px solid rgba(30,47,80,.7); }
  tr + tr th { border-top: 1px solid rgba(30,47,80,.7); }
  td.num { text-align: right; padding-right: 14px; white-space: nowrap; }
  .scroll { overflow-x: auto; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; font-size: 12.5px; }
  .kv div:nth-child(odd) { color: var(--dim); }
  .kv div:nth-child(even) { text-align: right; }
  canvas { width: 100%; height: 170px; display: block; }
  .legend { display: flex; gap: 16px; font-size: 12px; color: var(--dim); margin-top: 6px; }
  .swatch { display: inline-block; width: 18px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
  .note { color: var(--dim); font-size: 12px; line-height: 1.55; }
  .note b { color: var(--text); font-weight: 600; }
  #login { max-width: 340px; margin: 60px auto; }
  #login input {
    width: 100%; margin: 6px 0; padding: 9px 12px; border-radius: 10px;
    background: var(--bg); border: 1px solid var(--border); color: var(--text); font: inherit;
  }
  #err { color: var(--red); font-size: 12px; min-height: 16px; }
  .temp-banner {
    border: 1px dashed rgba(179,136,255,.5); background: rgba(179,136,255,.07);
    color: var(--purple); border-radius: 12px; padding: 8px 13px; font-size: 12px; margin-bottom: 16px;
  }
</style>
</head>
<body>
<div class="wrap">
  <div id="login" class="card" hidden>
    <h1 style="margin-bottom:12px">Sign in</h1>
    <input id="u" placeholder="Username" autocomplete="username">
    <input id="p" type="password" placeholder="Password" autocomplete="current-password">
    <div id="err"></div>
    <button id="go" style="width:100%;margin-top:8px;padding:9px">Sign in</button>
  </div>

  <div id="app" hidden>
    <div class="head">
      <h1>Sensor Diagnostics</h1>
      <span class="sub" id="clock"></span>
      <span style="flex:1"></span>
      <button id="pause" data-on="1">Live</button>
    </div>

    <div class="temp-banner">
      Temporary diagnostic page &mdash; read-only. Built for the CT02 port-B fault hunt (F4).
    </div>

    <div class="strip" id="strip"></div>

    <h2>CT02 &mdash; open-firmware power meter</h2>
    <div id="ct02"></div>

    <h2>ESP mains monitor</h2>
    <div id="esp"></div>

    <h2>Qingping CGS2 &mdash; air</h2>
    <div id="air"></div>

    <h2>Ambient Weather WS-2000</h2>
    <div id="weather"></div>

    <h2>Tuya shadow feed (superseded by the flash)</h2>
    <div id="tuya"></div>

    <h2>Stored rows</h2>
    <div id="counts"></div>
  </div>
</div>

<script>
(function () {
  "use strict";

  var POLL_MS = 2000;
  var live = true;
  var timer = null;
  var last = null;
  var inFlight = false;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v, digits) {
    if (v === null || v === undefined || v === "" || isNaN(Number(v))) return "\\u2014";
    return Number(v).toFixed(digits === undefined ? 2 : digits);
  }
  function age(sec) {
    if (sec === null || sec === undefined) return "never";
    if (sec < 0) sec = 0;
    if (sec < 60) return sec + "s ago";
    if (sec < 3600) return Math.floor(sec / 60) + "m " + (sec % 60) + "s ago";
    if (sec < 86400) return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m ago";
    return Math.floor(sec / 86400) + "d ago";
  }
  function ageMs(ms, now) {
    if (ms === null || ms === undefined) return "never";
    return age(Math.round((now - ms) / 1000));
  }
  function health(sec, warnAt, badAt) {
    if (sec === null || sec === undefined) return "off";
    if (sec >= badAt) return "bad";
    if (sec >= warnAt) return "warn";
    return "ok";
  }

  // ---- rendering -------------------------------------------------------

  function pill(label, cls, detail) {
    return '<div class="pill"><span class="dot ' + cls + '"></span><span>' + esc(label) +
      '</span><span class="sub">' + esc(detail) + "</span></div>";
  }

  function renderStrip(d) {
    var out = [];
    var c = d.ct02 && d.ct02.connection;
    if (!c || !c.configured) {
      out.push(pill("CT02 MQTT", "off", "not configured"));
    } else if (!c.connected) {
      out.push(pill("CT02 MQTT", "bad", "broker disconnected"));
    } else {
      var msgAge = c.lastMessageAt === null ? null : Math.round((d.now - c.lastMessageAt) / 1000);
      out.push(pill("CT02 MQTT", health(msgAge, 60, 180), c.messageCount + " msgs \\u00b7 " + ageMs(c.lastMessageAt, d.now)));
    }
    // A silent cap would misreport coverage: if unknown topics are being
    // dropped, say so where it is seen, not only in the JSON.
    if (c && c.topicsEvicted > 0) {
      out.push(pill("Topics dropped", "warn", c.topicsEvicted + " over cap"));
    }
    out.push(pill("ESP mains", health(d.esp.liveAgeSeconds, 15, 60), age(d.esp.liveAgeSeconds)));
    out.push(pill("Air", health(d.air.liveAgeSeconds, 120, 600), age(d.air.liveAgeSeconds)));
    out.push(pill("Weather", health(d.weather.lastStoredAgeSeconds, 600, 1800), age(d.weather.lastStoredAgeSeconds)));
    out.push(pill("Tuya shadow", health(d.tuya.lastStoredAgeSeconds, 300, 900), age(d.tuya.lastStoredAgeSeconds)));

    // The collector loop once parked for ~4 h on an unanswered Xiaomi 2FA prompt
    // with no error logged; air/power kept flowing and masked it. Its age is the
    // signal that would have shown it, so it belongs on a diagnostics page.
    if (d.collectorLoopAgeMs !== null && d.collectorLoopAgeMs !== undefined) {
      var loopSec = Math.round(d.collectorLoopAgeMs / 1000);
      out.push(pill("Collector loop", health(loopSec, 420, 900), age(loopSec)));
    }
    el("strip").innerHTML = out.join("");
  }

  function chVal(ch, key, digits) {
    var c = ch[key];
    if (!c) return "\\u2014";
    return num(c.value, digits);
  }

  function portCard(d, port) {
    var ch = d.ct02.channels;
    var suffix = port === "A" ? "_a" : "_b";
    var cur = ch["current" + suffix];
    var pw = ch["power" + suffix];
    var imp = ch["import" + suffix];
    var exp = ch["export" + suffix];
    var a = d.ct02.assessment;
    // Red means "this is the faulty port", never merely "this port is idle".
    // An idle line reading 0.003 A is normal and must not look like a fault.
    var dead = (port === "B" && a.verdict === "b-silent-while-a-live")
      || (port === "A" && a.verdict === "b-live-while-a-silent");
    // A port that has not reported inside the assessment window is showing the
    // last thing it said, not what it is saying. It must not be coloured green
    // by its magnitude — an hours-old 4 A would read as a live 4 A.
    // The server decides staleness — restating its window here as a literal
    // would silently drift out of step with it.
    var stale = port === "A" ? a.aStale : a.bStale;
    var flowing = !stale && cur && cur.value > 0.02;
    var valueClass = stale ? "stale" : (flowing ? "live" : (dead ? "zero" : ""));

    var rows = [
      ["Raw integer (mA)", cur ? cur.raw : "\\u2014"],
      ["Power", pw ? num(pw.value, 1) + " W" : "\\u2014"],
      ["Energy import", imp ? num(imp.value, 3) + " kWh" : "\\u2014"],
      ["Energy export", exp ? num(exp.value, 3) + " kWh" : "\\u2014"],
      ["Updates received", cur ? cur.updateCount : 0],
      ["Value unchanged for", cur ? plural(cur.unchangedFor, "update") : "\\u2014"],
      ["Last update", cur ? ageMs(cur.updatedAt, d.now) : "never"]
    ];
    var kv = rows.map(function (r) {
      return "<div>" + esc(r[0]) + "</div><div class='mono'>" + esc(r[1]) + "</div>";
    }).join("");

    return '<div class="card port-' + port.toLowerCase() + (dead ? " port-dead" : "") + '">' +
      '<div class="port-title port-' + port.toLowerCase() + '"><span>PORT ' + port + "</span>" +
      '<span class="sub">' + (port === "A" ? "IAP / IAN" : "IBP / IBN") + "</span></div>" +
      '<div class="big ' + valueClass + '">' +
      (cur ? num(cur.value, 3) : "\\u2014") + "<small>A</small>" +
      (stale && cur ? '<small class="stale-tag">last known</small>' : "") + "</div>" +
      '<div class="kv" style="margin-top:12px">' + kv + "</div></div>";
  }

  function renderCt02(d) {
    var box = el("ct02");
    if (!d.ct02) {
      box.innerHTML = '<div class="card note">CT02 feed is not configured on this server.</div>';
      return;
    }
    var a = d.ct02.assessment;
    var ch = d.ct02.channels;
    var vclass = a.verdict === "both-live" ? "v-ok"
      : (a.verdict === "b-silent-while-a-live" || a.verdict === "b-live-while-a-silent") ? "v-bad"
      : (a.verdict === "both-idle" || a.verdict === "stale") ? "v-idle" : "v-none";
    var vtitle = {
      "no-data": "No readings yet",
      "stale": "Readings are stale \\u2014 verdict withheld",
      "both-live": "Both CT ports are reading",
      "b-silent-while-a-live": "Port B silent while port A carries current",
      "b-live-while-a-silent": "Port A silent while port B carries current",
      "both-idle": "Both ports idle \\u2014 no load on the conductor"
    }[a.verdict] || a.verdict;

    var html = '<div class="verdict ' + vclass + '"><b>' + esc(vtitle) + "</b>" + esc(a.detail) +
      '<div class="sub" style="margin-top:6px">window ' + a.windowSeconds + "s \\u00b7 " + a.sampleCount +
      " observations \\u00b7 A peak " + num(a.aMax, 3) + " A \\u00b7 B peak " + num(a.bMax, 3) +
      " A \\u00b7 A reported " + age(a.aAgeSeconds) + " \\u00b7 B reported " + age(a.bAgeSeconds) +
      "</div></div>";

    html += '<div class="grid g2">' + portCard(d, "A") + portCard(d, "B") + "</div>";

    html += '<div class="grid g4" style="margin-top:12px">' +
      statCard("Voltage", chVal(ch, "voltage", 2), "V") +
      statCard("Frequency", chVal(ch, "frequency", 2), "Hz") +
      statCard("Messages", d.ct02.connection.messageCount, "") +
      statCard("Reconnects", d.ct02.connection.reconnectCount, "") + "</div>";

    html += deviceCard(d);

    html += '<div class="card" style="margin-top:12px"><canvas id="chart"></canvas>' +
      '<div class="legend"><span><i class="swatch" style="background:#00d4ff"></i>Current A</span>' +
      '<span><i class="swatch" style="background:#ff9800"></i>Current B</span></div></div>';

    html += '<div class="card" style="margin-top:12px"><div class="note" style="margin-bottom:10px">' +
      "<b>Terminal-swap test.</b> With the unit unplugged from mains, move clamp A's wires to IBN/IBP and " +
      "clamp B's to IAN/IAP, leaving both clamps on the conductor. If the zero follows the <b>clamp</b>, " +
      "clamp B is bad. If it stays on <b>port B</b>, the board's B path is at fault." +
      "</div>" + topicTable(d) + "</div>";

    box.innerHTML = html;
    drawChart(d.ct02.history);
  }

  // Non-channel topics the device republishes with its periodic full broadcast.
  var DEVICE_TOPICS = [
    ["build", "Firmware"], ["ip", "IP"], ["mac", "MAC"], ["ssid", "Wi-Fi SSID"],
    ["rssi", "RSSI (dBm)"], ["freeheap", "Free heap (B)"], ["uptime", "Uptime (s)"],
    ["temp", "Chip temp (\\u00b0C)"], ["sockets", "Sockets"], ["connected", "LWT"]
  ];

  function deviceCard(d) {
    var base = d.ct02.connection.topicBase;
    var byTopic = {};
    d.ct02.topics.forEach(function (t) { byTopic[t.topic] = t; });

    var rows = DEVICE_TOPICS.map(function (pair) {
      var t = byTopic[base + "/" + pair[0]];
      var val = t ? t.value : "\\u2014";
      if (pair[0] === "uptime" && t) val = age(Number(t.value)).replace(" ago", "");
      return "<div>" + esc(pair[1]) + "</div><div class='mono'>" + esc(val) + "</div>";
    }).join("");

    return '<div class="card" style="margin-top:12px">' +
      '<div class="sub" style="margin-bottom:8px">Device health</div>' +
      '<div class="kv">' + rows + "</div></div>";
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function statCard(label, value, unit) {
    return '<div class="card"><div class="sub">' + esc(label) + "</div>" +
      '<div class="big" style="font-size:22px;margin-top:4px">' + esc(value) +
      (unit ? "<small>" + esc(unit) + "</small>" : "") + "</div></div>";
  }

  function topicTable(d) {
    var rows = d.ct02.topics.map(function (t) {
      return "<tr><td class='mono'>" + esc(t.topic) + "</td><td class='num mono'>" + esc(t.value) +
        "</td><td class='num'>" + t.count + "</td><td class='num sub'>" + ageMs(t.updatedAt, d.now) + "</td></tr>";
    }).join("");
    if (!rows) rows = "<tr><td class='sub'>No messages received on this device's topics yet.</td></tr>";
    return '<div class="scroll"><table><tr><th>Topic</th><th class="num">Value</th>' +
      '<th class="num">Msgs</th><th class="num">Last</th></tr>' + rows + "</table></div>";
  }

  function drawChart(history) {
    var cv = el("chart");
    if (!cv) return;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    var g = cv.getContext("2d");
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);

    var pts = history.filter(function (s) { return s.current_a !== null || s.current_b !== null; });
    if (pts.length < 2) {
      g.fillStyle = "#7a8ba8"; g.font = "13px Inter, sans-serif";
      g.fillText("Waiting for readings\\u2026", 10, 24);
      return;
    }

    var maxV = 0.1;
    pts.forEach(function (s) {
      if (s.current_a !== null) maxV = Math.max(maxV, s.current_a);
      if (s.current_b !== null) maxV = Math.max(maxV, s.current_b);
    });
    maxV *= 1.15;

    var t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    var span = Math.max(1, t1 - t0);
    var x = function (t) { return ((t - t0) / span) * (w - 44) + 38; };
    var y = function (v) { return h - 18 - (v / maxV) * (h - 30); };

    g.strokeStyle = "rgba(30,47,80,.9)"; g.fillStyle = "#7a8ba8";
    g.font = "10px 'SF Mono', Consolas, monospace"; g.lineWidth = 1;
    for (var i = 0; i <= 3; i++) {
      var v = (maxV / 3) * i, yy = Math.round(y(v)) + 0.5;
      g.beginPath(); g.moveTo(38, yy); g.lineTo(w - 6, yy); g.stroke();
      g.fillText(v.toFixed(2), 2, yy + 3);
    }

    [["current_a", "#00d4ff"], ["current_b", "#ff9800"]].forEach(function (series) {
      g.strokeStyle = series[1]; g.lineWidth = 1.8; g.beginPath();
      var started = false;
      pts.forEach(function (s) {
        var val = s[series[0]];
        if (val === null) return;
        var px = x(s.ts), py = y(val);
        if (started) g.lineTo(px, py); else { g.moveTo(px, py); started = true; }
      });
      g.stroke();
    });
  }

  function kvCard(title, obj, skip) {
    if (!obj) return '<div class="card"><div class="sub">' + esc(title) + "</div>" +
      '<div class="note" style="margin-top:6px">No data.</div></div>';
    var keys = Object.keys(obj).filter(function (k) { return skip.indexOf(k) < 0; });
    var kv = keys.map(function (k) {
      var v = obj[k];
      if (v !== null && typeof v === "object") v = JSON.stringify(v);
      return "<div>" + esc(k) + "</div><div class='mono'>" + esc(v === null ? "\\u2014" : v) + "</div>";
    }).join("");
    return '<div class="card"><div class="sub" style="margin-bottom:8px">' + esc(title) + "</div>" +
      '<div class="kv">' + kv + "</div></div>";
  }

  function renderEsp(d) {
    var l = d.esp.live;
    var head = '<div class="grid g4" style="margin-bottom:12px">' +
      statCard("Voltage", l ? num(l.voltage, 1) : "\\u2014", "V") +
      statCard("Grid (i1)", l ? num(l.current_1, 2) : "\\u2014", "A") +
      statCard("Generator (i2)", l ? num(l.current_2, 2) : "\\u2014", "A") +
      statCard("Reading age", age(d.esp.liveAgeSeconds), "") + "</div>";
    el("esp").innerHTML = head + '<div class="grid g2">' +
      kvCard("Live in-memory reading", l, []) +
      kvCard("Newest stored row \\u00b7 " + age(d.esp.lastStoredAgeSeconds), d.esp.lastStored, []) + "</div>";
  }

  function renderAir(d) {
    el("air").innerHTML = '<div class="grid g2">' +
      kvCard("Live MQTT reading", d.air.live, []) +
      kvCard("Newest stored row \\u00b7 " + age(d.air.lastStoredAgeSeconds), d.air.lastStored, []) + "</div>";
  }

  function renderWeather(d) {
    el("weather").innerHTML = kvCard(
      "Newest stored row \\u00b7 " + age(d.weather.lastStoredAgeSeconds), d.weather.lastStored, []);
  }

  function renderTuya(d) {
    el("tuya").innerHTML = kvCard(
      "Newest stored row \\u00b7 " + age(d.tuya.lastStoredAgeSeconds), d.tuya.lastStored, []);
  }

  function renderCounts(d) {
    var rows = Object.keys(d.counts).map(function (k) {
      var n = d.counts[k];
      return "<tr><td class='mono'>" + esc(k) + "</td><td class='num mono'>" +
        (n === null ? "unavailable" : n.toLocaleString()) + "</td></tr>";
    }).join("");
    el("counts").innerHTML = '<div class="card scroll"><table><tr><th>Table</th>' +
      '<th class="num">Rows</th></tr>' + rows + "</table></div>";
  }

  function render(d) {
    last = d;
    renderStrip(d);
    renderCt02(d);
    renderEsp(d);
    renderAir(d);
    renderWeather(d);
    renderTuya(d);
    renderCounts(d);
    el("clock").textContent = new Date(d.now).toLocaleTimeString();
  }

  // ---- polling ---------------------------------------------------------

  function showLogin(show) {
    el("login").hidden = !show;
    el("app").hidden = show;
  }

  // One scheduler only. A second chain would double the server's query load for
  // the life of the page, and logging in used to start one on top of the first.
  function schedule() {
    clearTimeout(timer);
    if (live) timer = setTimeout(poll, POLL_MS);
  }

  function poll() {
    if (inFlight) return;
    inFlight = true;
    clearTimeout(timer);
    // Without a deadline, a request that never settles leaves inFlight stuck
    // true with no timer pending — the page then stops updating for good.
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var killer = setTimeout(function () { if (ctl) ctl.abort(); }, POLL_MS * 5);
    fetch("/api/diag", {
      credentials: "same-origin",
      cache: "no-store",
      signal: ctl ? ctl.signal : undefined
    })
      .then(function (r) {
        if (r.status === 401) { showLogin(true); return null; }
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (d) { if (d) { showLogin(false); render(d); } })
      .catch(function (e) {
        var c = el("clock");
        if (c) c.textContent = "fetch failed: " + e.message;
      })
      .finally(function () {
        clearTimeout(killer);
        inFlight = false;
        schedule();
      });
  }

  el("pause").addEventListener("click", function () {
    live = !live;
    this.dataset.on = live ? "1" : "0";
    this.textContent = live ? "Live" : "Paused";
    clearTimeout(timer);
    if (live) poll();
  });

  el("go").addEventListener("click", function () {
    el("err").textContent = "";
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username: el("u").value, password: el("p").value })
    }).then(function (r) {
      if (!r.ok) { el("err").textContent = r.status === 429 ? "Too many attempts." : "Wrong credentials."; return; }
      showLogin(false);
      poll();
    }).catch(function (e) { el("err").textContent = e.message; });
  });

  el("p").addEventListener("keydown", function (e) { if (e.key === "Enter") el("go").click(); });
  window.addEventListener("resize", function () { if (last && last.ct02) drawChart(last.ct02.history); });

  poll();
})();
</script>
</body>
</html>
`;
