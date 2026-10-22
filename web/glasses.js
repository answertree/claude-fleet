import { waitForEvenAppBridge, TextContainerProperty, ListContainerProperty, ListItemContainerProperty, ImageContainerProperty, ImageRawDataUpdate, CreateStartUpPageContainer, RebuildPageContainer, TextContainerUpgrade, OsEventTypeList as E } from "/glasses/sdk.js";
// Opened from fleet (the QR code) the secret is in the address and fleet is where the page came from. Installed from
// Even Hub, fleet's address is written in when it is packed, and the secret comes from pairing (below), never the package.
// The addresses it may reach are fixed when it is packed (Even allows only those listed in app.json); the setup on
// the phone picks one of them, kept in the app's own storage.
const PACKED = !"__FLEET_BASE__".startsWith("__");
const ORIGINS = PACKED ? JSON.parse('__FLEET_ORIGINS__') : [];
let BASE = PACKED ? "__FLEET_BASE__" : "";
let token = new URLSearchParams(location.search).get("t") || "";
const q = (path, extra) => BASE + path + "?t=" + encodeURIComponent(token) + (extra || "");
const say = (t) => (document.getElementById("s").textContent = t);
const W = 576, H = 288;
const QUICK = ["yes, go ahead", "continue", "looks good, carry on", "stop and tell me where you are"];
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const bar = (pct, n) => "━".repeat(Math.round((pct / 100) * n)) + "─".repeat(n - Math.round((pct / 100) * n));
let data = { sessions: [], counts: {}, clock: "" }, view = "slide", sel = 0, pickAt = 0, sid = null, page = 0, pages = [""], choices = [], started = false, busy = false, sending = false;

const bridge = await waitForEvenAppBridge();
say("Connected: Claude Fleet is on your glasses.");

const text0 = (id, name, x, y, w, h, content, capture, z) => new TextContainerProperty({ xPosition: x, yPosition: y, width: w, height: h, borderWidth: 0, borderColor: 0, paddingLength: 4, containerID: id, containerName: name, content: cut(content, 1000), isEventCapture: capture ? 1 : 0, ...(z !== undefined ? { zOrderIndex: z } : {}) });
// A list sits directly under what is above it: the glasses centre a list's items in its height, so it is only as tall as they are.
const list = (id, name, y, h, items) => new ListContainerProperty({ xPosition: 0, yPosition: y, width: W, height: Math.min(h, items.length * 40 + 8), borderWidth: 0, borderColor: 0, paddingLength: 4, containerID: id, containerName: name, isEventCapture: 1, itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items.map((i) => cut(i, 64)) }) });
// Input is ignored for a moment after a screen appears: a new list sends an event of its own (it reads as a tap), and
// a tap arrives twice (from the container, then from the system), so the second half would act on the new screen.
let settleUntil = 0;
async function show(p) {
  settleUntil = Date.now() + 1200;
  if (!started) {
    started = true;
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(p));
    if (r !== 0) say("The glasses would not take the page (" + r + ").");
  } else await bridge.rebuildPageContainer(new RebuildPageContainer(p));
}
const upgrade = (id, name, content) => bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content: cut(content, 1000) }));
const current = () => data.sessions.find((s) => s.sid === sid);

// ── drawn on the phone: the slide and a session's dashboard, on a canvas in the system font, sent as four tiles ──
const FONT = '-apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';
// Greys come out brighter on the glasses than on a screen: the low tones are kept low, so what matters stands out.
const COL = { hi: "#ffffff", mid: "#b0b0b0", lo: "#686868", faint: "#2c2c2c", fill: "#0e0e0e" };
const canvas = document.createElement("canvas");
canvas.width = W;
canvas.height = H;
const g = canvas.getContext("2d");
const tileCanvases = [0, 1, 2, 3].map(() => Object.assign(document.createElement("canvas"), { width: 288, height: 144 }));
let sentTiles = ["", "", "", ""];
const setFont = (px, weight) => (g.font = (weight || 400) + " " + px + "px " + FONT);
function fitText(s, maxW) {
  s = s || "";
  if (!maxW || g.measureText(s).width <= maxW) return s;
  while (s.length && g.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}
function text(s, x, y, px, colour, weight, maxW) {
  setFont(px, weight);
  g.fillStyle = colour;
  const t = fitText(s, maxW);
  g.fillText(t, x, y);
  return g.measureText(t).width;
}
function textR(s, right, y, px, colour, weight, maxW) {
  setFont(px, weight);
  const t = fitText(s, maxW);
  const w = g.measureText(t).width;
  g.fillStyle = colour;
  g.fillText(t, right - w, y);
  return w;
}
function wrapText(s, maxW, px, lines) {
  setFont(px);
  const out = [];
  let line = "";
  for (const word of (s || "").split(" ")) {
    const next = line ? line + " " + word : word;
    if (g.measureText(next).width > maxW && line) {
      out.push(line);
      line = word;
      if (out.length === lines) break;
    } else line = next;
  }
  if (out.length < lines && line) out.push(line);
  if (out.length === lines && (s || "").length > out.join(" ").length) out[lines - 1] = fitText(out[lines - 1] + " …", maxW);
  return out;
}
function rrect(x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function pill(x, y, w, h, frac, colour) {
  rrect(x, y, w, h, h / 2);
  g.fillStyle = COL.faint;
  g.fill();
  if (frac > 0) {
    rrect(x, y, Math.max(h, w * Math.min(1, frac)), h, h / 2);
    g.fillStyle = colour;
    g.fill();
  }
}
// The state, drawn: ▲ needs you, ● working, half a circle stalled, a tick just finished, ▶ your turn, ○ quiet.
function stateIcon(state, x, cy, r, colour) {
  g.fillStyle = g.strokeStyle = colour;
  g.lineWidth = 2;
  g.beginPath();
  if (state === "needs") { g.moveTo(x + r, cy - r); g.lineTo(x + 2 * r, cy + r * 0.8); g.lineTo(x, cy + r * 0.8); g.closePath(); g.fill(); }
  else if (state === "working") { g.arc(x + r, cy, r * 0.8, 0, Math.PI * 2); g.fill(); }
  else if (state === "stalled") { g.arc(x + r, cy, r * 0.8, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(x + r, cy, r * 0.8, Math.PI / 2, Math.PI * 1.5); g.fill(); }
  else if (state === "justDone") { g.moveTo(x, cy); g.lineTo(x + r * 0.7, cy + r * 0.7); g.lineTo(x + r * 2, cy - r * 0.8); g.stroke(); }
  else if (state === "yourTurn") { g.moveTo(x + r * 0.3, cy - r * 0.8); g.lineTo(x + r * 1.8, cy); g.lineTo(x + r * 0.3, cy + r * 0.8); g.closePath(); g.fill(); }
  else { g.arc(x + r, cy, r * 0.75, 0, Math.PI * 2); g.stroke(); }
}
function resample(values, n) {
  if (!values || !values.length) return [];
  const step = values.length / n;
  return Array.from({ length: n }, (_, i) => { let v = 0; for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) v += values[j] || 0; return v; });
}
// Activity as rounded bars, scaled to the busiest.
function bars(values, x, y, w, h, colour, gap) {
  const n = Math.max(1, Math.min(values.length || 1, Math.floor(w / 4)));
  const cols = resample(values, n);
  const max = Math.max(1, ...cols);
  const bw = w / n;
  g.fillStyle = COL.faint;
  g.fillRect(x, y + h - 1, w, 1);
  g.fillStyle = colour;
  cols.forEach((v, i) => {
    if (!v) return;
    const bh = Math.max(2, Math.sqrt(v / max) * (h - 2));
    rrect(x + i * bw, y + h - 1 - bh, Math.max(1.5, bw - (gap ?? 1.5)), bh, Math.min(2, bw / 2));
    g.fill();
  });
}
// A sparkline: a smooth line with a soft fill under it.
function spark(values, x, y, w, h, colour) {
  const n = Math.max(2, Math.min(40, (values || []).length));
  const cols = resample(values || [], n);
  const max = Math.max(1, ...cols);
  const pts = cols.map((v, i) => [x + (i / (n - 1)) * w, y + h - (Math.sqrt(v / max) * (h - 2) + 1)]);
  g.beginPath();
  g.moveTo(pts[0][0], y + h);
  for (const [px, py] of pts) g.lineTo(px, py);
  g.lineTo(x + w, y + h);
  g.closePath();
  g.fillStyle = COL.fill;
  g.fill();
  g.beginPath();
  pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.strokeStyle = colour;
  g.lineWidth = 1.5;
  g.stroke();
}
// Context over the last quarter hour, filled, against the window's size.
function area(points, x, y, w, h) {
  g.fillStyle = COL.faint;
  g.fillRect(x, y, w, 1);
  g.fillRect(x, y + h - 1, w, 1);
  if (!points || !points.length) return;
  const pts = points.map(([fx, fy]) => [x + fx * w, y + h - 1 - fy * (h - 2)]);
  pts.push([x + w, pts[pts.length - 1][1]]);
  g.beginPath();
  g.moveTo(pts[0][0], y + h - 1);
  for (const [px, py] of pts) g.lineTo(px, py);
  g.lineTo(pts[pts.length - 1][0], y + h - 1);
  g.closePath();
  g.fillStyle = "#121212";
  g.fill();
  g.beginPath();
  pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.strokeStyle = COL.hi;
  g.lineWidth = 2;
  g.stroke();
}
function ring(frac, cx, cy, r, colour) {
  g.lineWidth = 3;
  g.strokeStyle = COL.faint;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = colour;
  g.beginPath();
  g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac));
  g.stroke();
}
// Done bright, going mid, still to come an outline.
function segments(done, doing, total, x, y, w, h) {
  if (!total) return;
  const n = Math.min(total, Math.floor(w / 6));
  const sw = w / n;
  for (let i = 0; i < n; i++) {
    const k = ((i + 0.5) * total) / n;
    rrect(x + i * sw, y, sw - 2, h, 2);
    if (k <= done) { g.fillStyle = COL.hi; g.fill(); }
    else if (k <= done + doing) { g.fillStyle = COL.lo; g.fill(); }
    else { g.strokeStyle = COL.faint; g.lineWidth = 1; g.stroke(); }
  }
}
const prWord = (p) => (p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.fail ? p.fail + " failing" : p.pending ? "CI " + p.pass + "/" + (p.pass + p.fail + p.pending) : p.state ? "CI green" : "");
const loud = (s) => s.state === "needs" || s.state === "stalled" || s.state === "justDone";

function drawSlide() {
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  g.textBaseline = "alphabetic";
  const h = data.header || {};
  const c = data.counts || {};
  text("Claude Fleet", 10, 24, 19, COL.hi, 600);
  textR(data.clock || "", W - 10, 24, 19, COL.hi, 600);
  // Counts, each with its shape.
  let x = 10;
  const count = (state, n, label, colour) => {
    if (!n) return;
    stateIcon(state, x, 39, 5, colour);
    x += 16 + text(n + " " + label, x + 14, 44, 13, colour, 500) + 8;
  };
  count("needs", c.needs, c.needs === 1 ? "needs you" : "need you", COL.hi);
  count("stalled", c.stalled, "stuck", COL.hi);
  count("working", c.working, "working", COL.mid);
  if (c.agents) x += text(c.agents + (c.agents === 1 ? " agent" : " agents"), x, 44, 13, COL.lo) + 14;
  if (c.workflows) text("≡ " + c.workflows + (c.workflows === 1 ? " workflow" : " workflows"), x, 44, 13, COL.lo);
  if (!c.needs && !c.stalled && !c.working) text("all quiet", 10, 44, 13, COL.mid);
  // The five-hour limit, always, with its forecast.
  const pct = (h.five || "").match(/(\d+)%/);
  text("5h", 10, 63, 12, COL.lo, 600);
  if (pct) {
    pill(30, 55, 110, 6, Number(pct[1]) / 100, h.urgent ? COL.hi : COL.mid);
    text((h.five || "").replace(/^5h\s*/, ""), 148, 63, 12, h.urgent ? COL.hi : COL.mid, h.urgent ? 600 : 400, 250);
  } else text((h.five || "").replace(/^5h:?\s*/, ""), 30, 63, 12, COL.lo, 400, 300);
  textR([h.week !== undefined ? "7d " + h.week + "%" : "", "cpu " + (h.cpu ?? 0) + "%", "mem " + (h.mem ?? 0) + "%", h.machines > 1 ? h.machines + " machines" : ""].filter(Boolean).join("  ·  "), W - 10, 63, 12, COL.lo);
  g.fillStyle = COL.faint;
  g.fillRect(10, 71, W - 20, 1);
  // The sessions, as many lines each as there is room for.
  const list = data.sessions || [];
  // Five or more: one row each, so all of them are on the screen at once. Fewer: richer cards.
  if (list.length >= 5) return drawRows(list);
  const lines = list.length <= 2 ? 4 : 3;
  const cardH = 8 + lines * 19;
  const top = 77, bottom = 270;
  const fit = Math.max(1, Math.floor((bottom - top + 4) / (cardH + 4)));
  const first = Math.max(0, Math.min(sel - Math.floor(fit / 2), list.length - fit));
  list.slice(first, first + fit).forEach((s, i) => {
    const y = top + i * (cardH + 4);
    if (first + i === sel) {
      rrect(4, y, W - 8, cardH, 8);
      g.strokeStyle = COL.hi;
      g.lineWidth = 2;
      g.stroke();
      rrect(4, y + 6, 4, cardH - 12, 2);
      g.fillStyle = COL.hi;
      g.fill();
    }
    const ch = s.chart || {};
    stateIcon(s.state, 14, y + 15, 6, loud(s) ? COL.hi : COL.mid);
    const stateText = s.word.toLowerCase() + (s.time ? " " + s.time : "");
    const sw = textR(stateText, W - 14, y + 20, 13, loud(s) ? COL.hi : COL.mid, loud(s) ? 600 : 400);
    const nw = text(s.name, 32, y + 20, 16, COL.hi, 600, W - 60 - sw - 60);
    if (s.host) text(s.host, 40 + nw, y + 20, 12, COL.lo, 400, 120);
    // Line two: the question or what it is doing; activity and context to the right.
    text(s.needs ? "? " + s.needs : s.now, 32, y + 39, 13, s.needs ? COL.hi : COL.mid, s.needs ? 500 : 400, W - 32 - 170);
    spark(ch.spark, W - 160, y + 28, 90, 14, COL.mid);
    if (s.ctx) {
      ring(s.ctx.pct / 100, W - 52, y + 34, 7, s.ctx.pct >= 80 ? COL.hi : COL.mid);
      text(s.ctx.pct + "%", W - 41, y + 39, 11, COL.lo);
    }
    if (lines >= 3) {
      const wf = (ch.workflows || [])[0];
      let x3 = 32;
      if (wf) {
        x3 += text("≡ " + wf.name + (wf.phase ? " · " + wf.phase : ""), x3, y + 58, 12, COL.lo, 400, 220) + 8;
        segments(wf.done, wf.doing, wf.total, x3, y + 50, Math.min(110, wf.total * 10), 7);
        x3 += Math.min(110, wf.total * 10) + 8;
        x3 += text(wf.done + "/" + wf.total, x3, y + 58, 12, COL.lo) + 12;
      } else if (s.doing) x3 += text("◐ " + s.doing, x3, y + 58, 12, COL.lo, 400, 260) + 12;
      const extra = [s.agents ? s.agents + " agents" : "", ...(ch.prs || []).map((p) => "#" + p.n + " " + prWord(p)), s.fails ? s.fails + " failed" : ""].filter(Boolean).join("  ·  ");
      if (extra) text(extra, x3, y + 58, 12, COL.lo, 400, W - 14 - x3);
    }
    if (lines >= 4 && s.said && !s.needs) text("Claude: " + s.said, 32, y + 77, 12, COL.lo, 400, W - 46);
  });
  if (!list.length) text("Nothing working, nothing waiting on you.", 32, 120, 15, COL.mid);
  text("ring: choose   ·   tap: open   ·   double tap: exit", 10, 284, 11, COL.lo);
  if (list.length > fit) textR(sel + 1 + " of " + list.length, W - 10, 284, 11, COL.lo);
}

// Five or more sessions: one row each: state, name and machine, what it needs or does, activity, context, state and time.
function drawRows(list) {
  const top = 77, rowH = 31;
  const fit = Math.floor((272 - top) / rowH);
  const first = Math.max(0, Math.min(sel - Math.floor(fit / 2), list.length - fit));
  list.slice(first, first + fit).forEach((s, i) => {
    const y = top + i * rowH;
    if (first + i === sel) {
      rrect(4, y, W - 8, rowH - 3, 7);
      g.strokeStyle = COL.hi;
      g.lineWidth = 2;
      g.stroke();
      rrect(4, y + 5, 4, rowH - 13, 2);
      g.fillStyle = COL.hi;
      g.fill();
    }
    const ch = s.chart || {};
    const base = y + 19;
    stateIcon(s.state, 14, base - 5, 5, loud(s) ? COL.hi : COL.mid);
    const stateText = s.word.toLowerCase() + (s.time ? " " + s.time : "");
    textR(stateText, W - 12, base, 12, loud(s) ? COL.hi : COL.lo, loud(s) ? 600 : 400, 112);
    const nw = text(s.name, 30, base, 14, COL.hi, 600, 150);
    const right = W - 12 - 112 - 14 - 92; // fixed columns, so the graphs line up row to row
    text(s.needs ? "? " + s.needs : s.now, 38 + nw, base, 12, s.needs ? COL.hi : COL.lo, s.needs ? 500 : 400, right - 38 - nw - 6);
    spark(ch.spark, right, base - 12, 60, 13, COL.mid);
    if (s.ctx) ring(s.ctx.pct / 100, right + 80, base - 5, 6, s.ctx.pct >= 80 ? COL.hi : COL.mid);
  });
  text("ring: choose   ·   tap: open   ·   double tap: exit", 10, 284, 11, COL.lo);
  if (list.length > fit) textR(sel + 1 + " of " + list.length, W - 10, 284, 11, COL.lo);
}

function drawDetail() {
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  const s = current();
  if (!s) { text("That session has finished.", 20, 140, 18, COL.hi, 600); return; }
  const ch = s.chart || {};
  const h = data.header || {};
  stateIcon(s.state, 10, 17, 7, loud(s) ? COL.hi : COL.mid);
  const stateText = s.word.toLowerCase() + (s.time ? " " + s.time : "");
  const sw = textR(stateText, W - 10, 22, 14, loud(s) ? COL.hi : COL.mid, 600);
  text(s.name, 30, 23, 19, COL.hi, 600, W - 50 - sw);
  textR(h.five || "", W - 10, 40, 11, h.urgent ? COL.hi : COL.lo, h.urgent ? 600 : 400, 280);
  text(s.host ? s.host : "", 10, 40, 11, COL.lo, 400, 260);
  wrapText(s.needs ? "? " + s.needs : s.now, W - 20, 14, 2).forEach((l, i) => text(l, 10, 59 + i * 17, 14, s.needs ? COL.hi : COL.mid, s.needs ? 500 : 400));
  g.fillStyle = COL.faint;
  g.fillRect(10, 84, W - 20, 1);
  // Left: activity, context, tasks.
  const L = 10, LW = 268;
  text("Activity", L, 101, 12, COL.lo, 600);
  textR((ch.tools || 0) + " tools · " + (ch.out || "0") + " out · " + (h.window || 30) + "m", L + LW, 101, 12, COL.mid);
  bars(ch.spark || [], L, 107, LW, 46, COL.mid);
  text("Context", L, 170, 12, COL.lo, 600);
  if (s.ctx) textR(s.ctx.pct + "% of " + (s.ctx.max || "?") + (s.ctx.runway ? " · " + s.ctx.runway : ""), L + LW, 170, 12, s.ctx.pct >= 80 ? COL.hi : COL.mid);
  area(ch.ctx || [], L, 176, LW, 40);
  if (ch.tasks && ch.tasks.total) {
    text("Tasks", L, 235, 12, COL.lo, 600);
    textR(ch.tasks.done + " of " + ch.tasks.total + " done", L + LW, 235, 12, COL.mid);
    segments(ch.tasks.done, ch.tasks.doing, ch.tasks.total, L, 241, LW, 8);
    if (s.doing) text("◐ " + s.doing, L, 266, 12, COL.mid, 400, LW);
  }
  // Right: workflows, agents, pull requests, failures, then what Claude said, as room allows.
  const R = 298, RW = 268;
  let y = 101;
  for (const wf of (ch.workflows || []).slice(0, 2)) {
    const tw = textR((wf.phase ? wf.phase + " · " : "") + wf.done + "/" + wf.total, R + RW, y, 12, COL.mid);
    text("≡ " + wf.name, R, y, 13, COL.hi, 600, RW - tw - 8);
    segments(wf.done, wf.doing, wf.total, R, y + 6, RW, 8);
    y += 30;
  }
  if ((ch.agents || []).length) {
    text("Agents " + ch.agents.length, R, y, 12, COL.lo, 600);
    y += 17;
    for (const a of ch.agents.slice(0, Math.max(0, Math.floor((246 - y) / 17) + 1))) {
      if (y > 246) break;
      stateIcon(a.state === "active" ? "working" : a.state === "stalled" ? "stalled" : a.state === "tool" ? "stalled" : "idle", R, y - 4, 4, a.state === "stalled" ? COL.hi : COL.mid);
      text(a.label, R + 13, y, 12, COL.mid, 400, RW - 100);
      spark(a.spark, R + RW - 80, y - 11, 80, 12, COL.lo);
      y += 17;
    }
  }
  for (const p of (ch.prs || []).slice(0, 2)) {
    if (y > 262) break;
    const word = prWord(p);
    text("#" + p.n + "  " + word, R, y + 4, 12, p.fail ? COL.hi : COL.mid, p.fail ? 600 : 400, 150);
    const total = p.pass + p.fail + p.pending;
    if (p.state === "OPEN" && total) {
      g.fillStyle = COL.faint; g.fillRect(R + RW - 100, y - 3, 100, 6);
      g.fillStyle = COL.mid; g.fillRect(R + RW - 100, y - 3, (100 * p.pass) / total, 6);
      g.fillStyle = COL.hi; g.fillRect(R + RW - 100 + (100 * p.pass) / total, y - 3, (100 * p.fail) / total, 6);
    }
    y += 18;
  }
  if (s.fails && y <= 262) { text("✕ " + s.fails + " failed", R, y + 4, 12, COL.hi, 600); y += 18; }
  if (s.said && !s.needs && y <= 252) {
    text("Claude", R, y + 4, 12, COL.lo, 600);
    y += 19;
    for (const l of wrapText(s.said, RW, 12, Math.floor((270 - y) / 15) + 1)) { text(l, R, y, 12, COL.mid); y += 15; }
  }
  text("scroll: read   ·   tap: answer   ·   double tap: back", 10, 284, 11, COL.lo);
}

// The canvas, in four tiles; only those that changed go to the glasses, one at a time.
async function sendCanvas() {
  for (let i = 0; i < 4; i++) {
    const t = tileCanvases[i];
    const tg = t.getContext("2d");
    tg.fillStyle = "#000";
    tg.fillRect(0, 0, 288, 144);
    tg.drawImage(canvas, (i % 2) * 288, Math.floor(i / 2) * 144, 288, 144, 0, 0, 288, 144);
    const url = t.toDataURL("image/png");
    if (url === sentTiles[i] || (view !== "slide" && view !== "detail")) continue;
    const bytes = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
    await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 10 + i, containerName: "tile" + i, imageData: bytes }));
    sentTiles[i] = url;
  }
}

// ── a session: a fixed head, a paged body, a fixed foot ──
const HEAD = 62, FOOT = 32;
const LINE = 58; // characters to a line, near enough, in the glasses' font
function wrapLines(t) {
  const out = [];
  for (const para of t.split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(" ")) {
      if ((line + " " + word).trim().length > LINE && line) { out.push(line); line = "  " + word; }
      else line = line ? line + " " + word : word;
    }
    out.push(line);
  }
  return out;
}
function bodyLines(s) {
  const lines = [];
  if (s.needs) lines.push("? " + s.needs, "");
  else if (s.now) lines.push(s.now, "");
  if (s.ctx) lines.push("context  " + bar(s.ctx.pct, 12) + "  " + s.ctx.pct + "%" + (s.ctx.runway ? " · " + s.ctx.runway : ""));
  const facts = [s.tasks && "tasks " + s.tasks, s.agents && s.agents + " agents", s.fails && s.fails + " failed"].filter(Boolean);
  if (facts.length) lines.push(facts.join("   ·   "));
  if (s.doing) lines.push("now: " + s.doing);
  for (const p of s.prs) lines.push("PR " + p);
  if (s.roster && s.roster.length) lines.push("", ...s.roster);
  if (s.said && !s.needs) lines.push("", "Claude: " + s.said);
  return wrapLines(lines.join("\n"));
}
const PER_PAGE = 7;
function paginate(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += PER_PAGE) out.push(lines.slice(i, i + PER_PAGE).join("\n"));
  return out.length ? out : [""];
}
const headText = (s) => s.mark + " " + s.name.toUpperCase() + "\n" + [s.host, s.word + (s.time ? " " + s.time : "")].filter(Boolean).join("  ·  ");
const footText = () => "tap: answer    2× tap: back" + (pages.length > 1 ? "    page " + (page + 1) + "/" + pages.length + " (scroll)" : "");
async function session(id) {
  sid = id;
  view = "session";
  const s = current();
  if (!s) return slide();
  pages = paginate(bodyLines(s));
  page = Math.min(page, pages.length - 1);
  await show({ containerTotalNum: 3, textObject: [text0(1, "head", 0, 0, W, HEAD, headText(s), false), text0(2, "body", 0, HEAD, W, H - HEAD - FOOT, pages[page], true), text0(3, "foot", 0, H - FOOT, W, FOOT, footText(), false)] });
}

// ── answering: the choices on its own screen, Esc, Enter and quick replies ──
const BASIC = () => [{ label: "Esc · stop or cancel", key: "X" }, { label: "Enter", key: "E" }, ...QUICK.map((x) => ({ label: "“" + x + "”", text: x }))];
const answerPage = (note) => ({ containerTotalNum: 2, textObject: [text0(1, "head", 0, 0, W, 36, cut(note, 52) + "   ·   2× tap: back", false)], listObject: [list(2, "choices", 36, H - 36, choices.map((c) => c.label))] });
async function answer() {
  const s = current();
  if (!s) return slide();
  view = "answer";
  const asked = sid;
  choices = BASIC();
  pickAt = 0;
  await show(answerPage("Answer " + s.name + ": reading its screen…"));
  const r = await post("/api/choices", { sid });
  if (view !== "answer" || sid !== asked) return; // gone back meanwhile
  const options = (r.options || []).map((o) => ({ label: o.key + ". " + o.label, key: o.key }));
  if (options.length) {
    choices = [...options, ...BASIC()];
    pickAt = 0;
    await show(answerPage("Answer " + s.name + ": tap a choice"));
  } else await upgrade(1, "head", cut(r.ok ? "No numbered choice on its screen" : r.error || "Can't see its screen", 52) + "   ·   2× tap: back");
}
async function pick(i) {
  const c = choices[i];
  const s = current();
  if (!c || !s) return;
  busy = true;
  const r = c.key ? await post("/api/keys", { sid, key: c.key }) : await post("/api/send", { sid, text: c.text });
  await show({ containerTotalNum: 1, textObject: [text0(1, "done", 0, 0, W, H, (r.ok ? "■ " + (c.key ? "Pressed " + (c.key === "X" ? "Esc" : c.key === "E" ? "Enter" : c.key) : r.queued ? "Queued (busy)" : "Sent") + " in " + s.name : "x Not done: " + (r.error || "fleet did not answer")), true)] });
  setTimeout(async () => {
    busy = false;
    await refresh();
    await detail(sid);
  }, 1600);
}

async function post(path, body) {
  try {
    const r = await fetch(q(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch {
    return { ok: false, error: "can't reach fleet" };
  }
}
async function refresh() {
  try {
    const r = await fetch(q("/api/glasses"), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
    say("Connected · " + data.sessions.length + " sessions · " + data.clock);
  } catch {
    say("Can't reach fleet: is it running?");
  }
}

// The slide and a session's dashboard: four image tiles over an empty text layer that takes the ring and taps.
const tileContainers = () => [0, 1, 2, 3].map((i) => new ImageContainerProperty({ xPosition: (i % 2) * 288, yPosition: Math.floor(i / 2) * 144, width: 288, height: 144, containerID: 10 + i, containerName: "tile" + i, zOrderIndex: i + 2 }));
async function showCanvasView(name) {
  view = name;
  sentTiles = ["", "", "", ""];
  await show({ containerTotalNum: 5, textObject: [text0(1, "input", 0, 0, W, H, " ", true, 1)], imageObject: tileContainers() });
  await redraw();
}
async function redraw() {
  if (sending) return;
  sending = true;
  try {
    if (view === "slide") drawSlide();
    else if (view === "detail") drawDetail();
    else return;
    await sendCanvas();
  } finally {
    sending = false;
  }
}
const slide = () => showCanvasView("slide");
const detail = (id) => { sid = id; page = 0; return showCanvasView("detail"); };

// Every few seconds: the slide or dashboard redrawn (only changed tiles go), or the open text page in place.
async function tick() {
  if (busy) return;
  await refresh();
  sel = Math.min(sel, Math.max(0, data.sessions.length - 1));
  if (view === "slide" || view === "detail") {
    if (view === "detail" && !current()) return slide();
    await redraw();
  } else if (view === "session") {
    const s = current();
    if (!s) return slide();
    const next = paginate(bodyLines(s));
    if (next.join() !== pages.join()) {
      pages = next;
      page = Math.min(page, pages.length - 1);
      await upgrade(2, "body", pages[page]);
      await upgrade(3, "foot", footText());
    }
  }
}

const typeOf = (env) => (env ? (env.eventType ?? E.CLICK_EVENT) : null);
bridge.onEvenHubEvent(async (e) => {
  if (busy) return;
  const types = [typeOf(e.listEvent), typeOf(e.textEvent), typeOf(e.sysEvent)];
  if (types.includes(E.SYSTEM_EXIT_EVENT) || types.includes(E.ABNORMAL_EXIT_EVENT)) return;
  if (Date.now() < settleUntil) return;
  if (e.listEvent) pickAt = e.listEvent.currentSelectItemIndex ?? 0;
  if (types.includes(E.DOUBLE_CLICK_EVENT)) {
    if (view === "answer" || view === "session") return detail(sid);
    if (view === "detail") return slide();
    return bridge.shutDownPageContainer(1);
  }
  const down = types.includes(E.SCROLL_BOTTOM_EVENT), up = types.includes(E.SCROLL_TOP_EVENT);
  if (down || up) {
    if (view === "slide") {
      sel = Math.max(0, Math.min(data.sessions.length - 1, sel + (down ? 1 : -1)));
      return redraw();
    }
    if (view === "detail") { page = 0; return session(sid); } // the text, to read in full
    if (view === "session") {
      if (up && page === 0) return detail(sid);
      page = Math.max(0, Math.min(pages.length - 1, page + (down ? 1 : -1)));
      await upgrade(2, "body", pages[page]);
      return upgrade(3, "foot", footText());
    }
    return;
  }
  if (types.includes(E.CLICK_EVENT)) {
    settleUntil = Date.now() + 800; // the other half of this tap
    if (view === "slide" && data.sessions[sel]) return detail(data.sessions[sel].sid);
    if (view === "detail" || view === "session") return answer();
    if (view === "answer") return pick(pickAt);
  }
});
// Installed: the secret kept from pairing, if it still opens fleet; else pair. The glasses show a code; you approve it on
// Telegram or the Fleet page; the app keeps the secret in its own storage on the phone.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Kept in the app's own storage (the SDK's, which the Even app keeps per app), and in the WebView's as well, in case.
const keep = async (k, v) => { try { await bridge.setLocalStorage(k, v); } catch {} try { localStorage.setItem(k, v); } catch {} };
const kept = async (k) => { let v = ""; try { v = (await bridge.getLocalStorage(k)) || ""; } catch {} if (!v) try { v = localStorage.getItem(k) || ""; } catch {} return v; };
const notice = (lines) => show({ containerTotalNum: 1, textObject: [text0(1, "pair", 0, 0, W, H, lines, true)] });
async function pair() {
  for (;;) {
    let start = null;
    try { start = await (await fetch(BASE + "/api/pair/start", { method: "POST" })).json(); } catch {}
    if (!start || !start.id) {
      say("Can't reach fleet at " + BASE + ". Is your Mac awake, and your phone on Tailscale?");
      conn("Can't reach fleet at " + BASE.replace("http://", "").replace("https://", "") + ". Is your Mac awake, and your phone on Tailscale? Or pick another address above.");
      await notice("Claude Fleet\n\nCan't reach fleet at " + BASE.replace("http://", "").replace("https://", "") + ".\nIs your Mac awake, and your phone on Tailscale?\n\nTrying again…");
      await wait(5000);
      continue;
    }
    say("Pair with Claude Fleet: code " + start.code + ". Approve it on Telegram or the Fleet page.");
    conn("Waiting for you to approve code " + start.code + " (Telegram, or the Fleet page).");
    await notice("Pair with Claude Fleet\n\nCode   " + start.code + "\n\nApprove it on Telegram or the Fleet page on your phone.");
    for (let i = 0; i < 300; i++) {
      await wait(2000);
      let r = null;
      try { r = await (await fetch(BASE + "/api/pair/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: start.id }) })).json(); } catch {}
      if (r && r.status === "approved" && r.token) {
        await keep("fleet-token", r.token);
        return r.token;
      }
      if (r && (r.status === "denied" || r.status === "expired")) break;
    }
  }
}
// The setup, on the phone: which of the packed addresses to use, whether it is paired, and a way to pair again.
const conn = (t) => (document.getElementById("conn").textContent = t);
if (PACKED) {
  const chosen = await kept("fleet-base"); if (chosen && ORIGINS.includes(chosen)) BASE = chosen;
  const pick = document.getElementById("base");
  for (const o of ORIGINS) { const opt = document.createElement("option"); opt.value = o; opt.textContent = o.replace("http://", "").replace("https://", ""); pick.append(opt); }
  pick.value = BASE;
  document.getElementById("setup").hidden = false;
  conn("Connecting to " + BASE.replace("http://", "").replace("https://", "") + "…");
  document.getElementById("save").onclick = async () => { await keep("fleet-base", pick.value); location.reload(); };
  document.getElementById("forget").onclick = async () => { await keep("fleet-token", ""); location.reload(); };
}
if (!token && PACKED) {
  token = await kept("fleet-token");
  if (token) {
    const fine = await fetch(q("/api/glasses"), { cache: "no-store" }).then((r) => r.status !== 403, () => true);
    if (!fine) token = ""; // fleet's secret has changed since: pair again
  }
  if (!token) token = await pair();
}
if (PACKED) conn("Paired · connected to " + BASE.replace("http://", "").replace("https://", ""));
await refresh();
await slide();
setInterval(tick, 3000);
