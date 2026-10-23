const token = new URLSearchParams(location.search).get("t") || "";
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const segs = (list) => { const s = el("span"); for (const x of list) { const p = el("span", "", x.t); if (x.c) p.style.color = x.c; if (x.b) p.style.fontWeight = "700"; s.append(p); } return s; };
const row = (lead, color, content) => { const r = el("div", "row"); const l = el("span", "lead", lead); l.style.color = color; r.append(l, typeof content === "string" ? el("span", "", content) : content); return r; };
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
// A ring: a faint track, then each part as an arc in its colour, and the figure in the middle.
function ring(size, width, parts, label) {
  const r = (size - width) / 2, c = 2 * Math.PI * r;
  const svg = svgEl("svg", { width: size, height: size, viewBox: "0 0 " + size + " " + size });
  svg.append(svgEl("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: "#262d37", "stroke-width": width }));
  let at = 0;
  for (const p of parts) {
    const len = Math.max(0, Math.min(1, p.frac)) * c;
    if (len < 0.5) continue;
    svg.append(svgEl("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: p.color, "stroke-width": width, "stroke-dasharray": len + " " + (c - len), "stroke-dashoffset": -at, transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")", "stroke-linecap": parts.length === 1 ? "round" : "butt" }));
    at += len;
  }
  const t = svgEl("text", { x: size / 2, y: size / 2 + 4, "text-anchor": "middle", fill: "#f5f7fa", "font-size": Math.round(size * 0.24), "font-weight": "650", "font-family": "-apple-system,system-ui,sans-serif" });
  t.textContent = label;
  svg.append(t);
  return svg;
}
const tone = (pct) => (pct >= 80 ? "#f0625c" : pct >= 60 ? "#f5f7fa" : "#56cdd6");
function gaugeTile(label, pct, sub, hot) {
  const g = el("div", "gt" + (hot ? " hot" : ""));
  g.append(ring(50, 6, pct === undefined ? [] : [{ frac: pct / 100, color: tone(pct) }], pct === undefined ? "–" : pct + "%"), el("b", "", label), el("small", "", sub || ""));
  return g;
}
// Activity as a smooth area, in the card's colour.
function sparkSvg(values, colour) {
  const n = values.length || 1, w = 300, h = 36, max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / Math.max(1, n - 1)) * w, h - 2 - Math.sqrt(v / max) * (h - 4)]);
  const svg = svgEl("svg", { class: "spark", viewBox: "0 0 " + w + " " + h, preserveAspectRatio: "none" });
  if (!pts.length) return svg;
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  svg.append(svgEl("path", { d: line + " L" + w + " " + h + " L0 " + h + " Z", fill: colour, "fill-opacity": "0.18" }));
  svg.append(svgEl("path", { d: line, fill: "none", stroke: colour, "stroke-width": "1.6", "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
  return svg;
}
// When the five-hour limit runs out: the one thing the rings above don't say. A headline, a timeline of the
// window (now, when it runs out, the reset), and what that means.
// The fleet's pulse: every machine's tool calls, a bar a minute for the last hour.
function pulsePanel(p) {
  const box = document.getElementById("pulse");
  if (!p) return void box.replaceChildren();
  const max = Math.max(1, ...p.bars);
  const head = el("div", "ph"); const t = el("span"); t.append(el("b", "", "Fleet"), " " + (p.machines > 1 ? p.machines + " machines" : "this Mac"));
  const fig = el("span"); fig.append(el("em", "", p.tools), " tools · ", el("em", "", p.out), " out · " + p.bar + " a bar");
  head.append(t, fig);
  const bars = el("div", "bars");
  for (const n of p.bars) { const i = el("i", n ? "" : "z"); i.style.height = (n ? Math.max(6, Math.round((n / max) * 100)) : 4) + "%"; bars.append(i); }
  const ax = el("div", "ax"); ax.append(el("span", "", "an hour ago"), el("span", "", "now"));
  box.replaceChildren(head, bars, ax);
}
// Accounts, as the CLI's usage screen: open or closed as you left it on this phone.
const acctTone = (pct) => (pct >= 80 ? "#f0625c" : pct >= 60 ? "#f5f7fa" : "#56cdd6");
function usagePanel(list) {
  const box = document.getElementById("accts"), det = document.getElementById("usage");
  if (!list || !list.length) return void box.replaceChildren();
  if (!det.dataset.wired) { det.dataset.wired = "1"; try { det.open = localStorage.getItem("fleet-usage-open") === "1"; } catch {} det.addEventListener("toggle", () => { try { localStorage.setItem("fleet-usage-open", det.open ? "1" : "0"); } catch {} }); }
  const inUse = list.filter((a) => a.machines.length).length;
  // Closed, the summary says how the five hours end on each account: how many last to the reset, at what share each is
  // on pace to have used by then, and any that run out first (red) or are full. Open, each account says it for itself.
  const sum = document.getElementById("usage-sum"), five = list.map((a) => a.five).filter(Boolean);
  const lasts = five.filter((f) => f.kind === "lasts"), out = five.filter((f) => f.kind === "out"), full = five.filter((f) => f.kind === "full");
  const closed = el("span", "sc");
  if (five.length) {
    closed.append(lasts.length + (lasts.length === five.length && five.length > 1 ? " will all" : " will") + " last to 5h");
    if (lasts.length) {
      closed.append(" (");
      lasts.forEach((f, i) => { if (i) closed.append(", "); const p = el("b", "", f.pct + "%"); p.style.color = acctTone(f.pct); closed.append(p); });
      closed.append(" predicted)");
    }
    const at = (fs) => [...new Set(fs.map((f) => f.at).filter(Boolean))].map((t) => "~" + t).join(", ");
    if (out.length) closed.append(" · ", el("em", "out", out.length + (out.length === 1 ? " runs" : " run") + " out" + (at(out) ? " " + at(out) : "")));
    if (full.length) closed.append(" · ", el("em", "out", full.length + " full" + (at(full) ? " until " + at(full) : "")));
    if (five.length < list.length) closed.append(" · " + (list.length - five.length) + " not read");
  } else closed.append(list.length + " · " + inUse + " in use");
  sum.replaceChildren(closed, el("span", "so", list.length + " · " + inUse + " in use"));
  box.replaceChildren(...list.map((a) => {
    const c = el("div", "acct" + (a.machines.length ? "" : " idle"));
    const h = el("div", "ah"); h.append(el("b", "", a.unlisted ? "Not in your list" : a.name), el("span", "em", a.email || ""));
    if (a.machines.length) h.append(el("span", "on", "● " + a.machines.join(" · ")));
    c.append(h);
    for (const l of a.limits) {
      const r = el("div", "lim"), bar = el("div", "bar");
      if (typeof l.pct === "number") {
        const fill = el("i"); fill.style.width = Math.min(100, l.pct) + "%"; fill.style.background = a.stale ? "#3a404a" : acctTone(l.pct); bar.append(fill);
        if (typeof l.tick === "number") { const tk = el("b"); tk.style.left = Math.round(l.tick * 100) + "%"; bar.append(tk); }
      }
      const pc = el("span", "pc", typeof l.pct === "number" ? l.pct + "%" : "--"); pc.style.color = typeof l.pct === "number" && !a.stale ? acctTone(l.pct) : "#6b7380";
      r.append(el("span", "lb", l.label), bar, pc, el("span", "tx" + (l.full ? " full" : ""), l.text || ""));
      c.append(r);
    }
    if (a.forecast) { const f = el("div", "fc"); const k = a.forecast.kind === "lasts" ? "#50c878" : "#f0625c"; const m = /^(lasts|runs out|out|5h full)(.*)$/.exec(a.forecast.text); const em = el("em", "", m ? m[1] : a.forecast.text); em.style.color = k; f.append(em, m ? m[2] : ""); c.append(f); }
    if (a.status || a.unlisted) c.append(el("div", "st" + (a.status && !a.stale && /·/.test(a.status) ? " bad" : ""), [a.status, a.unlisted ? "add it with a in the CLI's usage screen" : ""].filter(Boolean).join(" · ")));
    return c;
  }));
}
function fivePanel(f) {
  const box = document.getElementById("five"); box.replaceChildren();
  if (!f || !f.kind) return;
  const k = f.kind === "full" ? "#f0625c" : f.kind === "out" ? "#e5b544" : "#50c878";
  box.style.setProperty("--k", k);
  const hl = el("div", "hl"), big = el("div", "big");
  const em = (t) => el("em", "", t);
  if (f.kind === "full") big.append("Out of tokens until ", em(f.resetAt || "the reset"));
  else if (f.kind === "out") big.append("Runs out ", em("~" + f.outAt));
  else if (f.kind === "lasts") big.append("Lasts to the ", em(f.resetAt + " reset"));
  else big.append("Too early to forecast");
  hl.append(big);
  if ((f.kind === "full" || f.kind === "out") && f.inText) hl.append(el("span", "in", "in " + f.inText));
  box.append(hl);
  if (f.start && f.resets && f.resets > f.start) {
    const span = f.resets - f.start, at = (t) => Math.max(0, Math.min(100, ((t - f.start) / span) * 100));
    const tl = el("div", "tl"), past = el("i"), now = el("b");
    past.style.cssText = "left:0;width:" + at(f.now) + "%;background:#3b4452";
    tl.append(past);
    if (f.kind === "out" && f.out) { const gap = el("i"); gap.style.cssText = "left:" + at(f.out) + "%;right:0;background:" + k + ";opacity:.55"; tl.append(gap); }
    if (f.kind === "full") { const gap = el("i"); gap.style.cssText = "left:" + at(f.now) + "%;right:0;background:" + k + ";opacity:.55"; tl.append(gap); }
    now.style.left = "calc(" + at(f.now) + "% - 1px)"; tl.append(now);
    const ends = el("div", "ends"), hm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const nowLabel = el("span", "now", "now"); nowLabel.style.left = Math.max(14, Math.min(72, at(f.now))) + "%";
    ends.append(el("span", "", hm(f.start)), nowLabel, el("span", "", "reset " + (f.resetAt || hm(f.resets))));
    box.append(tl, ends);
  }
  const note = f.kind === "out" ? (f.gap ? f.gap + " without tokens before the reset at this pace" : "just before the reset at this pace") : f.kind === "lasts" ? "~" + f.by + "% used by then at this pace" : f.kind === "full" ? "a fresh five hours starts then" : "";
  if (note) box.append(el("div", "note", note));
}
function quip(d) {
  const c = d.counts, n = d.sessions.length;
  const parts = [];
  if (c.needs) parts.push([c.needs === 1 ? "1 session wants you" : c.needs + " sessions want you", "needs"]);
  if (c.stalled) parts.push(c.stalled + " looking a bit stuck");
  if (c.working) parts.push(c.working + (c.working === 1 ? " grinding away" : " grinding away"));
  if (c.agents) parts.push(c.agents + (c.agents === 1 ? " agent hustling" : " agents hustling"));
  if (!n) return [["All quiet. Go and make a cup of tea."]];
  if (!c.needs && !c.stalled) parts.push(["nothing needs you, carry on", "all under control, apparently", "you could probably go outside"][Math.floor(d.now / 60000) % 3]);
  return parts.map((p) => (typeof p === "string" ? [p] : p));
}
// The roster, as the detail view lists it: the main thread, each workflow with its agents under it, other agents.
const GLYPH = { active: ["●", "#50c878", "pulse"], tool: ["◐", "#f5f7fa"], quiet: ["○", "#6b7380"], done: ["✓", "#50c878"], stalled: ["◐", "#f0625c"] };
function mini(values, color) {
  // A small activity line, like the card's own, in the agent's colour.
  const n = (values || []).length || 1, w = 64, h = 14, max = Math.max(1, ...(values || [0]));
  const svg = svgEl("svg", { width: w, height: h, viewBox: "0 0 " + w + " " + h, class: "mini" });
  const pts = (values || []).map((v, i) => [(i / Math.max(1, n - 1)) * w, h - 1 - Math.sqrt(v / max) * (h - 2)]);
  if (!pts.length) return svg;
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  svg.append(svgEl("path", { d: line + " L" + w + " " + h + " L0 " + h + " Z", fill: color, "fill-opacity": "0.2" }));
  svg.append(svgEl("path", { d: line, fill: "none", stroke: color, "stroke-width": "1.3", "stroke-linejoin": "round" }));
  return svg;
}
function rrow(cls, glyph, name, right, what, spark, color) {
  const r = el("div", "r " + cls);
  const g = el("span", "g" + (glyph[2] ? " " + glyph[2] : ""), glyph[0]); g.style.color = glyph[1];
  const rt = el("span", "right"); if (right) rt.append(right);
  const sub = el("div", "sub"); sub.append(what, mini(spark || [], color));
  r.append(g, el("span", "nm", name), rt, sub);
  return r;
}
function agentRow(a, child) {
  const w = el("span", "what");
  if (a.tool) w.append(el("span", "tool", a.tool), " " + (a.doing || "")); else w.append(a.doing || "");
  return rrow(child ? "child" : "", GLYPH[a.state] || GLYPH.quiet, a.label, (a.model ? a.model + " · " : "") + a.ago, w, a.spark, a.label === "main thread" ? "#5b7fbf" : "#4fb8c4");
}
function wfRow(w) {
  const right = el("span");
  // A tick per step while there are few; past five, a count, so the name and the progress keep their room.
  const st = el("span", "steps");
  if (w.done) { const x = el("span", "", w.done > 5 ? "✓ " + w.done : "✓".repeat(w.done)); x.style.color = "#50c878"; st.append(x); }
  if (w.doing) st.append(el("span", "", (w.done ? " " : "") + (w.doing > 4 ? "◐ " + w.doing : "◐".repeat(w.doing))));
  if (st.childNodes.length) right.append(st, " ");
  right.append(w.done + "/" + w.total + " · " + w.age);
  const what = el("span", "what");
  if (w.outcome === "running") w.phases.forEach((p, i) => {
    const x = el("span", "", (p.state === "done" ? "✓ " : p.state === "now" ? "◐ " : "○ ") + p.name);
    x.style.color = p.state === "done" ? "#6b7380" : p.state === "now" ? "#f5f7fa" : "#4a515c";
    if (p.state === "now") x.style.fontWeight = "700";
    if (i) what.append("  ");
    what.append(x);
  });
  else { what.append(w.outcome === "completed" ? "completed" + (w.tokens ? " · " + w.tokens + " tok" : "") : w.status || "failed"); if (w.outcome !== "completed") what.style.color = "#f0625c"; }
  const glyph = w.outcome === "running" ? ["≡", "#be94ff"] : w.outcome === "completed" ? ["✓", "#50c878"] : ["✗", "#f0625c"];
  return rrow("wf" + (w.outcome === "running" ? " live" : ""), glyph, w.name, right, what, w.spark, "#9b7bd9");
}
function roster(R) {
  const box = el("div", "roster");
  if (R.main) box.append(agentRow(R.main, false));
  // Each workflow folds to its own row (name, steps, phases) and a count of its agents; a tap opens the agents.
  for (const w of R.workflows) {
    if (!w.agents.length && !w.more) { box.append(wfRow(w)); continue; }
    const g = el("details", "wfg wf-" + w.name.replace(/[^w-]/g, "_")), sm = el("summary");
    const n = w.agents.length + (w.more || 0), busy = w.agents.filter((a) => a.state === "active" || a.state === "tool").length;
    sm.append(wfRow(w), el("div", "count", n + (n === 1 ? " agent" : " agents") + (busy ? " · " + busy + " working" : "")));
    g.append(sm);
    for (const a of w.agents) g.append(agentRow(a, true));
    if (w.more) g.append(el("div", "r child more", "+ " + w.more + " more agents"));
    box.append(g);
  }
  for (const a of R.agents) box.append(agentRow(a, false));
  if (R.finished) box.append(el("div", "r done-line", "✓ " + R.finished + " agent" + (R.finished === 1 ? "" : "s") + " finished in the window"));
  return box;
}
// A message in the chat, whole: the chat scrolls.
function talkLine(sid, m) {
  const p = el("p", m.who, m.text); p.dataset.k = sid + ":" + m.t;
  p.append(el("span", "ago", m.ago));
  return p;
}
// Answer buttons: the numbered choices on the session's own screen (read every few seconds while it waits),
// then Esc and Enter, then quick replies. A button arms on the first tap and sends on the second.
const QUICK = ["yes, go ahead", "continue", "looks good, carry on", "do what you think is best", "stop and tell me where you are", "what's left?", "summarise what you've done", "run the tests", "fix the failing tests", "commit and open a PR", "merge it once CI is green", "show me the diff", "keep it simpler", "try a different approach", "explain that simply", "wait, I'll check and come back"];
const screens = new Map(); // sid → { at, options, error, loading }
const chipScroll = new Map(); // sid → how far its quick replies are scrolled
let armed = { id: "", until: 0 };
async function post(path, body) {
  try {
    const r = await fetch(path + "?t=" + encodeURIComponent(token), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return await r.json().catch(() => ({ ok: false, error: "fleet said " + r.status }));
  } catch { return { ok: false, error: "can't reach fleet" }; }
}
// A waiting session's choices are read once a question, never on a timer: reading a background session's screen opens
// it in a hidden window, and it redraws itself at that window's size while that is open, so polling made it jump about
// in your own terminal (fleet keeps the answer too, for every page). Read again when its question changes, and when a
// read found nothing, after a minute.
const questionOf = (s) => (s.sub && s.sub.text) || "";
const choicesStale = (s, sc) => !sc || (!sc.loading && (sc.q !== questionOf(s) || (!(sc.options && sc.options.length) && Date.now() - sc.at > 60000)));
async function readScreen(sid) {
  const was = screens.get(sid) || {}, s = (fleetData().sessions || []).find((x) => x.sid === sid), q = s ? questionOf(s) : "";
  screens.set(sid, { ...was, q, loading: true, at: Date.now() });
  const r = await post("api/choices", { sid });
  screens.set(sid, { q, at: Date.now(), options: r.options || [], error: r.ok ? "" : r.error || "can't see its screen" });
  tick();
}
function answerButtons(s) {
  const box = el("div");
  const waiting = s.state === "needs";
  if (waiting) {
    const sc = screens.get(s.sid);
    if (choicesStale(s, sc)) void readScreen(s.sid);
    const picks = el("div", "picks");
    for (const o of (sc && sc.options) || []) picks.append(armable(s, "k" + o.key, "pick", [el("span", "k", o.key), el("span", "", o.label)], o.key + ". " + o.label, { key: o.key }));
    if (picks.childNodes.length) box.append(picks);
    else box.append(el("div", "picks-note", !sc || sc.loading && !sc.options ? "reading its screen…" : sc.error ? sc.error : "no numbered choice on its screen"));
  }
  const chips = el("div", "chips");
  const at = chipScroll.get(s.sid); if (at) requestAnimationFrame(() => (chips.scrollLeft = at));
  chips.addEventListener("scroll", () => chipScroll.set(s.sid, chips.scrollLeft), { passive: true });
  if (waiting) chips.append(armable(s, "esc", "chip key", ["Esc"], "Esc", { key: "X" }), armable(s, "enter", "chip key", ["Enter"], "Enter", { key: "E" }));
  QUICK.forEach((q, i) => chips.append(armable(s, "q" + i, "chip", [q], "“" + q + "”", { text: q })));
  if (!waiting) chips.prepend(armable(s, "esc", "chip key", ["Esc"], "Esc", { key: "X" }));
  box.append(chips);
  return box;
}
function armable(s, id, cls, content, what, act) {
  const full = s.sid + ":" + id, on = armed.id === full && Date.now() < armed.until;
  const b = el("button", cls + (on ? " armed" : "")); b.type = "button"; b.dataset.k = full;
  if (on) b.append(cls.startsWith("pick") ? el("span", "k", "↵") : "", "Tap again: " + what); else b.append(...content);
  b.addEventListener("click", async () => {
    if (!(armed.id === full && Date.now() < armed.until)) { armed = { id: full, until: Date.now() + 3000 }; setTimeout(tick, 3100); return tick(); }
    armed = { id: "", until: 0 };
    notes.set(s.sid, { cls: "", text: "sending…" }); tick();
    const r = act.key ? await post("api/keys", { sid: s.sid, key: act.key }) : await post("api/send", { sid: s.sid, text: act.text });
    const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    notes.set(s.sid, r.ok ? { cls: "ok", text: (act.key ? "pressed " + what : (r.queued ? "queued " : "sent ") + what) + (r.queued ? " ⏳ " : " ✓ ") + at } : { cls: "err", text: "not done: " + (r.error || "unknown") });
    screens.delete(s.sid); tick();
  });
  return b;
}
// The task list, as a workflow is shown: folded to a row with its progress and the task in hand; open, a row per task still to finish.
function taskList(T) {
  const d = el("details", "tasks"), sm = el("summary");
  const doing = T.open.filter((t) => t.status === "in_progress"), todo = T.open.filter((t) => t.status !== "in_progress");
  const bar = el("span", "tbar"); const n = Math.min(T.total, 24);
  for (let i = 0; i < n; i++) { const at = (i / n) * T.total; bar.append(el("i", at < T.done ? "d" : at < T.done + doing.length ? "n" : "")); }
  const right = el("span", ""); right.style.cssText = "display:inline-flex;gap:8px;align-items:center"; right.append(bar, T.done + "/" + T.total);
  const what = el("span", "what");
  if (doing.length) what.append(el("span", "", "◐ " + doing[0].text + (doing.length > 1 ? " +" + (doing.length - 1) : "")));
  else if (todo.length) what.append("next: " + todo[0].text); else what.append("all done");
  if (doing.length) what.firstChild.style.color = "#f5f7fa";
  const r = el("div", "r"); const g = el("span", "g", "☰"); g.style.color = "#56cdd6";
  const sub = el("div", "sub"); sub.append(what);
  r.append(g, el("span", "nm", "Tasks"), el("span", "right", ""), sub); r.querySelector(".right").append(right);
  sm.append(r); d.append(sm);
  for (const t of [...doing, ...todo]) {
    const row = el("div", "r child task " + (t.status === "in_progress" ? "now" : "pending"));
    const gl = el("span", "g", t.status === "in_progress" ? "◐" : "○"); gl.style.color = t.status === "in_progress" ? "#f5f7fa" : "#6b7380";
    const nm = el("span", "nm", t.text); if (t.blocked) nm.append(el("span", "blk", "blocked"));
    row.append(gl, nm, el("span", "right", t.since || ""));
    d.append(row);
  }
  if (T.done) d.append(el("div", "r child done-line", "✓ " + T.done + " done"));
  return d;
}
function card(s) {
  const c = el("section", "card" + (s.state === "needs" ? " needs" : "") + (isDone(s) ? " done" : "")); c.style.setProperty("--c", s.color);
  if (isDone(s) && !putAway()[s.sid]) swipeAway(c, s.sid);
  // The head: name and state, where it is; its context as a ring, split by what fills it, on the right.
  const top = el("div", "top"), left = el("div");
  // Its name opens the focus view: everything about it, with its own screen.
  const nm = el("div", "name", s.name); nm.style.cursor = "pointer"; nm.title = "Open " + s.name; nm.addEventListener("click", () => openFocus(s.sid));
  const head = el("div", "head"); head.append(nm, el("div", "state", s.word + (s.time ? " · " + s.time : ""))); left.append(head);
  if (s.place) left.append(el("div", "place", s.place));
  top.append(left);
  if (s.ctx) {
    const total = s.ctx.split.reduce((n, p) => n + p.tokens, 0) || 1;
    const parts = s.ctx.split.map((p) => ({ frac: (p.tokens / total) * (s.ctx.pct / 100), color: p.color }));
    const box = el("div", "ctxring"); box.append(ring(52, 6, parts.length ? parts : [{ frac: s.ctx.pct / 100, color: tone(s.ctx.pct) }], s.ctx.pct + "%"), el("div", "", "of " + s.ctx.max));
    top.append(box);
  }
  c.append(top);

  c.append(el("div", "sub", (s.sub.source === "prompt" ? "▸ " : s.sub.source === "reply" ? "◆ " : "") + (s.sub.text || "")));
  if (s.party) { c.append(el("div", "party", "✦ " + s.party + " ✦")); const f = el("div", "confetti"); const cols = ["#e5b544", "#50c878", "#56cdd6", "#be94ff", "#f0625c", "#61aaff"]; for (let i = 0; i < 28; i++) { const p = el("i"); p.style.left = (i * 37 % 100) + "%"; p.style.background = cols[i % cols.length]; p.style.animationDelay = (i % 9) * 0.25 + "s"; f.append(p); } c.append(f); }
  c.append(sparkSvg(s.spark, s.state === "needs" ? "#e5b544" : s.state === "stalled" ? "#f0625c" : "#6b9bff"));
  if (s.ctx && s.ctx.runway) c.append(row("◷", "#6b7380", s.ctx.runway));
  if (s.fails) c.append(row("✗", "#f0625c", s.fails.n + " failed · " + s.fails.last + " · " + s.fails.ago));
  for (const b of s.bg) c.append(row("↻", "#56cdd6", b.desc + " · " + b.ago));
  for (const p of s.prs) { const r = row("⇡", "#c6cdd7", segs(p)); r.classList.add("pr"); c.append(r); } // one line each, the title cut
  if (s.changes) c.append(row("±", "#6b7380", segs(s.changes)));
  const R = s.roster;
  if (s.tasks && s.tasks.total) c.append(taskList(s.tasks));
  if (R && (R.main || R.workflows.length || R.agents.length || R.finished)) c.append(roster(R));
  const m = chatHead(s);
  const f = el("form", "send"); const ta = el("textarea"); ta.rows = 1; ta.placeholder = s.state === "needs" ? "your answer…" : "type to " + s.name + "…"; ta.value = drafts.get(s.sid) || ""; ta.dataset.sid = s.sid;
  ta.addEventListener("input", () => { drafts.set(s.sid, ta.value); grow(ta); });
  if (ta.value) requestAnimationFrame(() => grow(ta));
  m.append(answerButtons(s));
  const go = el("button", "", "Send"); go.type = "submit"; f.append(ta, go); m.append(f);
  const note = el("div", "sent" + (notes.get(s.sid)?.cls ? " " + notes.get(s.sid).cls : ""), notes.get(s.sid)?.text || ""); m.append(note);

  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const text = ta.value.trim(); if (!text) return;
    go.disabled = true; note.className = "sent"; note.textContent = "sending…";
    try {
      const r = await fetch("api/send?t=" + encodeURIComponent(token), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid: s.sid, text }) });
      const d = await r.json().catch(() => ({ ok: false, error: "fleet said " + r.status }));
      if (d.ok) { following.set(s.sid, { text, at: Date.now() }); open.set(s.sid + "chat", true); stick.set(s.sid, true); const ch = f.closest("details.chat"); if (ch) ch.open = true; drafts.delete(s.sid); ta.value = ""; grow(ta); notes.set(s.sid, d.queued ? { cls: "ok", text: "queued ⏳ it's busy: delivers as soon as it can" } : { cls: "ok", text: "sent ✓ " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }); }
      else notes.set(s.sid, { cls: "err", text: "not sent: " + (d.error || "unknown") });
    } catch { notes.set(s.sid, { cls: "err", text: "not sent: can't reach fleet" }); }
    const n = notes.get(s.sid); note.className = "sent " + n.cls; note.textContent = n.text; go.disabled = false; ta.blur(); tick();
  });
  c.append(m);
  if (isDone(s) && !putAway()[s.sid]) c.append(el("div", "swipe-hint", "⟷ swipe to put away"));
  return c;
}
let last = 0, open = new Map();
// The message box: one line, taller as the words need it (to 40% of the screen, then it scrolls).
function grow(ta) {
  ta.style.height = "auto";
  const max = innerHeight * 0.4, h = Math.min(ta.scrollHeight + 2, max);
  ta.style.height = h + "px";
  ta.style.overflowY = ta.scrollHeight + 2 > max ? "auto" : "hidden";
}
// A node's layout: its tags, classes and what each message or button is for, not its words or figures.
const shapeOf = (n) => n.nodeType === 3 ? "#" : n.nodeType !== 1 ? "?" : n.tagName + "." + (n.getAttribute("class") || "") + "|" + (n.dataset ? n.dataset.k || "" : "") + "(" + [...n.childNodes].map(shapeOf).join(",") + ")";
// Bring a node up to date from one laid out the same, in place: its words and attributes; a text box keeps what you typed.
function patch(a, b) {
  if (a.nodeType === 3) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  if (a.nodeType !== 1) return;
  const own = (name) => a.tagName === "TEXTAREA" && name === "style"; // its height is its own, from what you typed
  for (const { name, value } of [...b.attributes]) if (!own(name) && a.getAttribute(name) !== value) a.setAttribute(name, value);
  for (const { name } of [...a.attributes]) if (!own(name) && !b.hasAttribute(name)) a.removeAttribute(name);
  for (let i = 0; i < a.childNodes.length; i++) patch(a.childNodes[i], b.childNodes[i]);
}
// The splash finishes its turn (the logo back at rest), holds 400 ms on the logo, then the app fades in quickly.
let leaving = false;
function leaveSplash() {
  const sp = document.getElementById("splash");
  if (!sp || leaving) return;
  leaving = true;
  const wait = window.splashMotion ? splashMotion.untilRest() : 0;
  setTimeout(() => { sp.classList.add("gone"); setTimeout(() => sp.remove(), 300); }, wait + 400);
}
// Finished cards a swipe has put away, by session, kept on this phone.
const isDone = (s) => s.state === "justDone" || s.state === "finished";
let showGone = false, swiping = false, touchedUntil = 0, touching = false, swipedAt = 0;
// A finished session's row or card, in any view, is put away by a swipe; what opens on a tap does not open for one.
const tapped = (fn) => () => { if (Date.now() - swipedAt > 400) fn(); };
addEventListener("pointerdown", () => { touching = true; touchedUntil = Infinity; }, { passive: true });
addEventListener("pointerup", () => { touching = false; touchedUntil = Date.now() + 700; }, { passive: true });
addEventListener("pointercancel", () => { touching = false; touchedUntil = Date.now() + 700; }, { passive: true });
addEventListener("scroll", () => { if (!touching) touchedUntil = Math.max(touchedUntil, Date.now() + 250); }, { passive: true, capture: true });
function putAway() { try { return JSON.parse(localStorage.getItem("fleet-put-away") || "{}") || {}; } catch { return {}; } }
function savePutAway(a) { try { localStorage.setItem("fleet-put-away", JSON.stringify(a)); } catch {} }
// A finished card follows a sideways swipe; far enough and it slides off and is put away. Up and down still scrolls.
function swipeAway(c, sid) {
  let x0 = null, y0 = 0, dx = 0, locked = false;
  const reset = () => { x0 = null; locked = false; swiping = false; };
  c.addEventListener("pointerdown", (e) => { if (e.target.closest("button,textarea,summary,a,input,.log,.chips")) return; x0 = e.clientX; y0 = e.clientY; dx = 0; locked = false; });
  c.addEventListener("pointermove", (e) => {
    if (x0 === null) return;
    dx = e.clientX - x0; const dy = e.clientY - y0;
    if (!locked) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return reset();
      if (Math.abs(dx) < 10) return;
      locked = true; swiping = true; try { c.setPointerCapture(e.pointerId); } catch {}
    }
    c.style.transition = "none"; c.style.transform = "translateX(" + dx + "px)"; c.style.opacity = String(1 - Math.min(0.7, Math.abs(dx) / c.offsetWidth));
  });
  const end = () => {
    if (!locked) return reset();
    swipedAt = Date.now();
    c.style.transition = "transform .22s ease, opacity .22s ease";
    if (Math.abs(dx) > Math.min(160, c.offsetWidth * 0.33)) { // a third of the way, or 160 px on a wide row or card
      c.style.transform = "translateX(" + Math.sign(dx) * c.offsetWidth * 1.2 + "px)"; c.style.opacity = "0";
      setTimeout(() => { const a = putAway(); a[sid] = Date.now(); savePutAway(a); reset(); tick(); }, 220);
    } else { c.style.transform = ""; c.style.opacity = ""; reset(); }
  };
  c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
}
const drafts = new Map(), notes = new Map();
let pageBuild = ""; // the build of the fleet that served this page, from its first state
// The conversation and the box to write in are one: folded, a line with the latest message; open, the recent
// messages in a short scroller that fades out at the top and stays at the newest unless you scroll back, what the
// session is doing, then the answers and the box. It opens when the session asks you something, and when you send.
const following = new Map(); // sid → { text, at }: what you just sent, shown until the transcript has it
const stick = new Map(); // sid → false while you have scrolled back through its messages
function chatHead(s) {
  const f = following.get(s.sid);
  if (f && Date.now() - f.at > 15 * 60_000) following.delete(s.sid);
  const live = following.get(s.sid);
  const d = el("details", "chat"); if (s.state === "needs" || live) d.open = true;
  // Its head is a row like Tasks and the workflows: the latest message beneath, while folded.
  const sm = el("summary"), last = s.talk[s.talk.length - 1];
  const r = el("div", "r"), g = el("span", "g", "❯"); g.style.color = "#61aaff";
  const sub = el("div", "sub"); sub.append(el("span", "what", last ? (last.who === "you" ? "You: " : "") + last.text.replace(/\s+/g, " ") : "Write to " + s.name));
  r.append(g, el("span", "nm", "Chat"), el("span", "right", last ? last.ago : ""), sub);
  sm.append(r); d.append(sm);
  const log = el("div", "log"); log.dataset.k = "log"; log.dataset.of = s.sid;
  for (const m of s.talk) log.append(talkLine(s.sid, m));
  if (live && !s.talk.some((m) => m.who === "you" && m.t >= live.at - 5000)) { const p = el("p", "you", live.text); p.dataset.k = "sent"; log.append(p); }
  if (!log.childNodes.length) log.append(el("div", "none", "Nothing said yet."));
  log.addEventListener("scroll", () => stick.set(s.sid, log.scrollHeight - log.scrollTop - log.clientHeight < 24), { passive: true });
  d.append(log);
  const busy = s.state === "working" || s.state === "stalled";
  if (busy) d.append(el("div", "st pulse", "◐ " + (s.sub && s.sub.source !== "reply" && s.sub.text ? s.sub.text : "thinking…")));
  // Opened by your tap (not by a redraw): straight to the newest message.
  sm.addEventListener("click", () => { if (!d.open) { stick.set(s.sid, true); requestAnimationFrame(settleLogs); } });
  return d;
}
// Each open conversation at its newest message, unless you have scrolled back.
function settleLogs() {
  for (const log of document.querySelectorAll("#cards .log")) if (stick.get(log.dataset.of) !== false) log.scrollTop = log.scrollHeight;
}
// Fleet pushes what it says over a live link (a WebSocket) whenever it changes; the page draws it, skipping what has
// not changed. The link comes back by itself if it drops (quickly, then every few seconds), and meanwhile the page
// asks now and then, so it never goes blank. tick() asks at once: after you have done something.
let lastText = "", latestText = "", linkDown = false;
async function tick(force = true) {
  try {
    const r = await fetch("api/state?t=" + encodeURIComponent(token), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    apply(await r.text(), force);
  } catch (e) { document.getElementById("foot").replaceChildren(el("span", "stale", "can't reach fleet — is it still running?")); const w = document.getElementById("splash-what"); if (w) w.textContent = "Can't reach fleet yet: is your Mac awake, and on Tailscale?"; }
}
function apply(text, force) {
  last = Date.now(); latestText = text;
  if (!force && text === lastText) return;
  // Nothing re-renders under a voice call: the phone's attention stays on the audio. Closing the call catches up.
  if (V.pc) return void (lastText = "");
  lastText = text;
  const d = JSON.parse(text);
  // Fleet was updated (its service restarts itself onto the new fleet.ts): this page is the old one, so it loads the new.
  // Never over something you are writing: then it waits for the next change after the text is sent or cleared.
  if (d.build && pageBuild && d.build !== pageBuild && ![...document.querySelectorAll("textarea")].some((t) => t.value.trim())) return void location.reload();
  pageBuild = pageBuild || d.build;
  const q = document.getElementById("quip"); q.replaceChildren(); quip(d).forEach(([text, cls], i) => { if (i) q.append(" · "); q.append(el("span", cls || "", text)); });
  // The gauges as rings: the five-hour and weekly limits (with when each resets), this machine's CPU and memory.
  const g = document.getElementById("gauges");
  const lim = (re) => (d.account ? d.account.limits.find((l) => re.test(l.label)) : undefined);
  const five = lim(/5/), week = lim(/7|week/i);
  g.replaceChildren(gaugeTile("5 hours", five ? five.pct : undefined, five ? five.resets : "no figures", !!(d.five && d.five.urgent)), gaugeTile("week", week ? week.pct : undefined, week ? week.resets : ""), gaugeTile("cpu", d.machine.cpu, "load " + d.machine.load), gaugeTile("memory", d.machine.mem, d.machine.memText));
  // The five-hour forecast, always.
  fivePanel(d.five);
  pulsePanel(d.pulse);
  usagePanel(d.accounts);
  // The glasses app asking to connect: allow it if your glasses show the same code.
  const pb = document.getElementById("pair");
  pb.replaceChildren(...(d.pairing || []).map((r) => {
    const box = el("div", "ask"); box.append("👓 Your glasses want to connect · code ", el("b", "", r.code));
    const row = el("div"); const yes = el("button", "yes", "Allow"), no = el("button", "no", "Deny");
    const decide = async (allow) => { yes.disabled = no.disabled = true; await fetch("api/pair/decide?t=" + encodeURIComponent(token), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: r.id, allow }) }).catch(() => {}); box.remove(); };
    yes.addEventListener("click", () => decide(true)); no.addEventListener("click", () => decide(false));
    row.append(yes, no); box.append(row); return box;
  }));
  applyOpts();
  newlyWaiting(d);
  needsStrip(d);
  burnPanel(d.burn);
  badge((d.counts && d.counts.needs) || 0);
  const cards = document.getElementById("cards");
  for (const det of cards.querySelectorAll("details")) open.set(det.closest(".card")?.dataset.sid + det.className, det.open);
  if (swiping || (!force && Date.now() < touchedUntil)) return void (lastText = ""); // nor under a card being swiped, or a finger scrolling
  timelineScale(d);
  const build = (s) => { const c = view === "compact" ? compactRow(s) : view === "timeline" ? timelineCard(s) : card(s); c.dataset.sid = s.sid; for (const det of c.querySelectorAll("details")) { const k = s.sid + det.className; if (open.has(k)) det.open = open.get(k); } return c; };
  // Finished sessions swiped away stay away (on this phone) until they start again; a button at the bottom shows them.
  const away = putAway();
  for (const sid of Object.keys(away)) { const s = d.sessions.find((x) => x.sid === sid); if (!s || !isDone(s)) delete away[sid]; }
  savePutAway(away);
  const shown = d.sessions.filter((s) => !away[s.sid]), gone = d.sessions.filter((s) => away[s.sid]);
  // The timeline is one screen: as many cards as fit at their least, most pressing first, and the rest named on a line.
  // The lanes are one board, every session on one axis; the other views a card or row a session.
  const fit = view === "timeline" ? timelineFit(shown.length) : shown.length;
  const list = view === "lanes" ? [lanesBoard(shown)] : view === "orbit" ? [orbitHost(d)] : shown.slice(0, fit).map(build);
  if (fit < shown.length) list.push(moreLine(shown.slice(fit)));
  if (!shown.length) list.push(el("div", "empty", gone.length ? "Nothing else here: everything left has finished." : "No sessions working and nothing waiting on you."));
  if (gone.length && !ONE_SCREEN.includes(view)) {
    const b = el("button", "shelf", showGone ? "Hide completed" : "Show " + gone.length + " completed"); b.type = "button";
    b.addEventListener("click", () => { showGone = !showGone; tick(); });
    list.push(b);
    if (showGone) for (const s of gone) { const c = build(s); c.classList.add("gone"); const pb = el("button", "putback", "Put back"); pb.type = "button"; pb.addEventListener("click", (e) => { e.stopPropagation(); const a = putAway(); delete a[s.sid]; savePutAway(a); tick(); }); if (c.classList.contains("crow")) c.append(pb); else c.prepend(pb); list.push(c); }
  }
  // Cards are updated in place, so nothing flickers and animations run on: a card laid out as before has only its
  // words and figures changed; one laid out differently is replaced, except the one you are typing in, where only
  // its conversation is.
  const typing = document.activeElement && document.activeElement.tagName === "TEXTAREA" && cards.contains(document.activeElement) ? document.activeElement.closest(".card") : null;
  const keyOf = (n) => (n.dataset && n.dataset.sid ? "s:" + n.dataset.sid + (n.classList.contains("gone") ? ":gone" : "") : "x:" + n.className);
  const was = new Map([...cards.children].map((n) => [keyOf(n), n]));
  const next = list.map((n) => {
    const o = was.get(keyOf(n));
    if (!o) return n;
    if (shapeOf(o) === shapeOf(n)) return patch(o, n), o;
    if (o !== typing) return n;
    const ol = o.querySelector(".chat .log"), nl = n.querySelector(".chat .log");
    if (ol && nl) shapeOf(ol) === shapeOf(nl) ? patch(ol, nl) : ol.replaceWith(nl);
    const os = o.querySelector(".chat > .st"), ns = n.querySelector(".chat > .st");
    if (os && ns) patch(os, ns); else if (os) os.remove(); else if (ns && o.querySelector(".chat .log")) o.querySelector(".chat .log").after(ns);
    return o;
  });
  // Only what changed is touched: moving a card would take the focus from its text box.
  const keep = new Set(next);
  for (const n of [...cards.children]) if (!keep.has(n)) n.remove();
  next.forEach((n, i) => { if (cards.children[i] !== n) cards.insertBefore(n, cards.children[i] || null); });
  settleLogs();
  layoutCards();
  renderFocus();
  document.getElementById("clock").textContent = new Date(d.now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const awayN = ONE_SCREEN.includes(view) ? d.sessions.filter((s) => putAway()[s.sid]).length : 0; // the one-screen views have no shelf: they say how many
  document.getElementById("foot").textContent = (d.hidden ? d.hidden + " idle or finished not shown · " : "") + (awayN ? awayN + " put away (the other views can show them) · " : "") + (linkDown ? "reconnecting…" : "live");
  document.getElementById("mic").hidden = !d.voice;
  document.title = (d.counts.needs ? "▲" + d.counts.needs + " " : "") + "Claude Fleet";
  leaveSplash();
}
// What came while the page held still (a finger on it, or typing) is drawn once it can be.
setInterval(() => { if (latestText && latestText !== lastText) apply(latestText, false); }, 700);
let ws, tries = 0, polling = 0;
function live() {
  const u = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + location.pathname.replace(/[^/]*$/, "") + "api/live?t=" + encodeURIComponent(token);
  try { ws = new WebSocket(u); } catch { return again(); }
  ws.onopen = () => { tries = 0; linkDown = false; clearInterval(polling); polling = 0; if (latestText) apply(latestText, true); }; // "live" again at once
  ws.onmessage = (e) => { if (typeof e.data === "string") apply(e.data, false); };
  ws.onclose = () => { ws = undefined; again(); };
}
function again() {
  tries++; linkDown = true;
  const f = document.getElementById("foot"); if (f && !f.querySelector(".stale")) f.textContent = "reconnecting…";
  if (!polling && tries >= 2) polling = setInterval(() => tick(false), 3000); // until the link is back
  setTimeout(live, Math.min(5000, 250 * 2 ** Math.min(tries, 5)));
}
// Back from the background (a phone locks its screen): straight back on the link.
document.addEventListener("visibilitychange", () => { if (!document.hidden && (!ws || ws.readyState > 1)) { tries = 0; live(); } });
// ── voice: talk to Fleet about your sessions ──
// The phone sends its WebRTC offer to fleet, which starts a GPT-Live conversation with its own key; the audio then flows
// between the phone and OpenAI. GPT-Live hands thinking and tools to a reasoning model, whose tool calls arrive here and
// are answered from what fleet sends the page and through fleet's own actions. Nothing is typed or pressed in a session
// until PB has seen the exact line on screen and said yes (or tapped Send).
const V = { pc: null, dc: null, mic: null, raf: 0, poll: 0, energy: {}, lv: { out: 0, mic: 0 }, lvAt: {}, ease: { out: 0, mic: 0 }, saidAt: 0, pbAt: 0, health: {}, startedAt: 0, muted: false, busy: 0, deleg: false, heardAt: 0, err: 0, calls: new Map(), n: 0, seen: new Set(), log: [] };
const $ = (id) => document.getElementById(id);
const vstate = (t) => ($("vstate").textContent = t);
const vtool = (t) => ($("vtool").textContent = t || "");
const fleetData = () => { try { return JSON.parse(latestText || lastText); } catch { return { sessions: [] }; } };
const segText = (list) => (list || []).map((x) => x.t).join("");
// A session by what PB called it: the closest name.
function sessionNamed(name) {
  const list = fleetData().sessions || [], n = String(name || "").toLowerCase().trim();
  if (!n) return undefined;
  const words = n.split(/\s+/);
  let best, score = 0;
  for (const s of list) {
    const m = s.name.toLowerCase();
    const k = m === n ? 100 : m.includes(n) || n.includes(m) ? 50 : words.filter((w) => w.length > 2 && m.includes(w)).length * 10;
    if (k > score) { score = k; best = s; }
  }
  return best;
}
const brief = (s) => ({
  name: s.name, state: s.word, for: s.time || undefined, where: s.place || undefined, now: s.sub && s.sub.text || undefined,
  question: s.state === "needs" ? s.sub && s.sub.text : undefined, context: s.ctx ? s.ctx.pct + "% of " + s.ctx.max : undefined,
  tasks: s.tasks && s.tasks.total ? s.tasks.done + " of " + s.tasks.total + " done" : undefined,
  workflows: (s.roster && s.roster.workflows || []).map((w) => ({ name: w.name, outcome: w.outcome, progress: w.done + " of " + w.total, phase: (w.phases || []).filter((p) => p.state === "now").map((p) => p.name).join(", ") || undefined })),
  agents: s.roster ? s.roster.agents.length + (s.roster.workflows || []).reduce((n, w) => n + (w.agents || []).length, 0) : 0,
  pullRequests: (s.prs || []).map(segText), failures: s.fails ? s.fails.n + " failed, last: " + s.fails.last : undefined,
});
const fleetPost = async (path, body) => { try { const r = await fetch(path + "?t=" + encodeURIComponent(token), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return await r.json(); } catch { return { ok: false, error: "can't reach fleet" }; } };
function vsend(o) { if (V.dc && V.dc.readyState === "open") V.dc.send(JSON.stringify(o)); }
// Tell Fleet something PB did on screen, for it to acknowledge in a word or two.
const vtell = (content) => vsend({ type: "session.commentary.append", event_id: "tell_" + (++V.n), delegation_id: null, content });

// What Fleet means to type or press: a card on screen until PB says yes, taps Send, or it is withdrawn. The only text
// shown in a call is these, so PB reads exactly what would go into a session.
const proposals = new Map();
const hhmm = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function drawCards() {
  const box = $("vcards"); box.replaceChildren();
  for (const p of [...proposals.values()].slice(-3)) {
    const c = el("div", "vcard " + p.state);
    c.append(el("div", "to", p.kind === "send" ? "To " + p.s.name : "Press " + (p.key === "E" ? "Enter" : p.key === "X" ? "Esc" : p.key) + " in " + p.s.name));
    c.append(el("div", "msg", p.kind === "send" ? p.text : p.meaning || ""));
    if (p.state === "pending") {
      const acts = el("div", "acts"), go = el("button", "go", p.kind === "send" ? "Send" : "Press"), no = el("button", "no", "Cancel");
      go.addEventListener("click", async () => { const r = await carryOut(p); vtell("PB tapped " + go.textContent + ": " + (r.ok ? (r.queued ? "it is queued for " : "it is done in ") + p.s.name : "it failed: " + r.error) + ". Acknowledge in two or three words."); });
      no.addEventListener("click", () => { p.state = "cancelled"; p.note = "Cancelled"; drawCards(); vtell("PB cancelled the proposal for " + p.s.name + ". Acknowledge in two or three words."); });
      acts.append(go, no); c.append(acts);
    } else c.append(el("div", "note", p.note || ""));
    box.append(c);
  }
}
async function carryOut(p) {
  if (p.state !== "pending") return { ok: false, error: "already " + p.state };
  p.state = "working"; p.note = p.kind === "send" ? "Sending…" : "Pressing…"; drawCards();
  const r = p.kind === "send" ? await fleetPost("api/send", { sid: p.s.sid, text: p.text }) : await fleetPost("api/keys", { sid: p.s.sid, key: p.key });
  p.state = r.ok ? (r.queued ? "queued" : "done") : "failed";
  p.note = r.ok ? (r.queued ? "Queued: " + p.s.name + " is busy, it goes in as soon as it can" : (p.kind === "send" ? "Sent ✓ " : "Pressed ✓ ") + hhmm()) : "Not done: " + (r.error || "unknown");
  drawCards();
  return r;
}
async function runTool(name, args) {
  const d = fleetData();
  if (name === "fleet_overview") return { time: new Date(d.now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), counts: d.counts, hiddenIdleOrFinished: d.hidden, sessions: (d.sessions || []).map(brief) };
  if (name === "usage") return { fiveHour: d.five && d.five.text, limits: d.account && d.account.limits, cpu: d.machine && d.machine.cpu + "%", memory: d.machine && d.machine.memText };
  if (name === "confirm" || name === "cancel") {
    const p = proposals.get(String(args.proposal || ""));
    if (!p) return { error: "no such proposal" };
    if (name === "cancel") { if (p.state === "pending") { p.state = "cancelled"; p.note = "Cancelled"; drawCards(); } return { cancelled: p.id }; }
    const r = await carryOut(p);
    return r.ok ? (r.queued ? { queued: true, to: p.s.name, note: "the session is busy; it goes in as soon as the session can take it" } : { done: true, in: p.s.name }) : { error: r.error };
  }
  const s = sessionNamed(args.name);
  if (!s) return { error: "No session called that. Sessions: " + (d.sessions || []).map((x) => x.name).join(", ") };
  if (name === "propose_message" || name === "propose_press") {
    const p = { id: "p" + (++V.n), kind: name === "propose_message" ? "send" : "press", s, text: String(args.text || "").trim(), key: String(args.key || ""), meaning: String(args.meaning || ""), state: "pending" };
    if (p.kind === "send" && !p.text) return { error: "nothing to send" };
    proposals.set(p.id, p); drawCards();
    return { proposal: p.id, showing: "on PB's screen with " + (p.kind === "send" ? "Send" : "Press") + " and Cancel", next: "read the gist back in a few words and ask; confirm only after a clear yes" };
  }
  vtool((name === "session_detail" ? "Looking at " : "Reading ") + s.name + "…");
  if (name === "session_detail") return { ...brief(s), conversation: (s.talk || []).map((m) => ({ who: m.who === "you" ? "PB" : "Claude", text: m.text, ago: m.ago })), openTasks: s.tasks ? s.tasks.open : [], threads: s.roster ? [...(s.roster.main ? [s.roster.main] : []), ...(s.roster.workflows || []).flatMap((w) => w.agents || []), ...(s.roster.agents || [])].map((a) => ({ name: a.label, doing: (a.tool ? a.tool + " " : "") + (a.doing || ""), ago: a.ago })) : [], changes: segText(s.changes) };
  if (name === "read_choices") { const r = await fleetPost("api/choices", { sid: s.sid }); return r.ok ? { options: r.options } : { error: r.error }; }
  return { error: "no such tool" };
}
async function onVoiceEvent(e) {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  const t = m.type || "";
  V.seen.add(t === "response.event" && m.event ? "response.event/" + m.event.type : t);
  if (t === "session.started" && V.waking) { if (V.listen) V.listen.draining = true; } // what PB said while it woke goes in first
  else if (t === "session.started") vtell("Greet PB as Fleet in a few words, then the one-line headline from what you know: what, if anything, is waiting on PB, and how many sessions are working. Then stop and listen.");
  else if (t === "session.delegation.created") { V.deleg = true; V.busy = Date.now(); vtool("Looking into it…"); }
  // Fleet talking with nothing handed off is not thinking (the start of a call, or between sentences). Its words are
  // not shown (only the cards are), but the last few are kept for a look from the console.
  else if (t === "session.input_transcript.delta") { V.pbAt = Date.now(); note("PB", m.delta || ""); }
  else if (t === "session.output_transcript.delta") { V.saidAt = Date.now(); note("Fleet", m.delta || ""); if (!V.deleg) V.busy = 0; V.log.push("Fleet: " + (m.delta || "")); V.log = V.log.slice(-400); }
  else if (t === "response.event" && m.event) {
    const ev = m.event;
    V.busy = Date.now();
    if (ev.type === "response.output_item.done" && ev.item && ev.item.type === "function_call") {
      const it = ev.item;
      if (V.calls.has(it.call_id)) return;
      let args = {}; try { args = JSON.parse(it.arguments || "{}"); } catch {}
      V.log.push("tool: " + it.name + " " + (it.arguments || ""));
      V.calls.set(it.call_id, runTool(it.name, args).catch((x) => ({ error: String(x) })));
    } else if (/^response\.(completed|done|failed|incomplete)$/.test(ev.type)) {
      // Every call this turn answered, then the backend carries on with the results.
      if (!V.calls.size) { V.deleg = false; V.busy = 0; vtool(""); return; }
      const calls = [...V.calls]; V.calls.clear();
      for (const [id, p] of calls) vsend({ type: "response.item.create", event_id: "out_" + id, item: { type: "function_call_output", call_id: id, output: JSON.stringify(await p).slice(0, 60000) } });
      vsend({ type: "response.create", event_id: "go_" + (++V.n) });
    }
  }
  else if (t === "session.closed") { const why = m.reason && m.reason !== "close_requested" ? " (" + String(m.reason).replace(/_/g, " ") + ")" : ""; closeVoice(false); V.err = 1; vstate("Call ended" + why); }
  else if (t === "error") { vtool(""); V.err = 1; vstate((m.error && m.error.message) || "Something went wrong"); setTimeout(() => (V.err = 0), 5000); }
}

// The fleet: seven orbs in the logo's colours, joined, turning with whoever speaks (Fleet one way, PB the other) and
// swelling with the voice; while Fleet thinks a pulse runs round them.
const ORBS = ["#0075fc", "#25d8fc", "#01abfd", "#01e6b3", "#63fa9b", "#3147fc", "#6c28fa"];
const orbView = { spin: 0, lv: 0, dir: 1, last: 0, w: 0 };
// The orbs' levels come from the call's own statistics (the energy each way over the last 50 ms), never an AudioContext:
// on an iPhone, tapping the call's audio with Web Audio is heard as clicks. A phone that leaves a figure out still has
// the timing of the words, from GPT-Live's transcripts.
async function pollLevels() {
  const pc = V.pc; if (!pc) return;
  try {
    const got = { out: -1, mic: -1 };
    (await pc.getStats()).forEach((r) => {
      if (r.type === "candidate-pair" && r.nominated) V.health.pair = r;
      const k = r.type === "inbound-rtp" && r.kind === "audio" ? "out" : r.type === "media-source" && r.kind === "audio" ? "mic" : "";
      if (!k) return;
      if (r.totalAudioEnergy !== undefined && r.totalSamplesDuration) {
        const was = V.energy[k]; V.energy[k] = [r.totalAudioEnergy, r.totalSamplesDuration];
        if (was && r.totalSamplesDuration > was[1]) got[k] = Math.sqrt((r.totalAudioEnergy - was[0]) / (r.totalSamplesDuration - was[1]));
      } else if (typeof r.audioLevel === "number") got[k] = r.audioLevel;
      if (k === "out") V.health.inbound = r;
    });
    for (const k of ["out", "mic"]) if (got[k] >= 0) { V.lv[k] = got[k]; V.lvAt[k] = Date.now(); }
  } catch {}
}
// From the words when the figures are missing: a lively flutter while words are arriving.
const flutter = (at, now) => (now - at < 450 ? 0.07 + 0.05 * Math.abs(Math.sin(now / 83)) + 0.03 * Math.abs(Math.sin(now / 37)) : 0);
function levelsNow() {
  const now = Date.now(), fresh = (k) => now - (V.lvAt[k] || 0) < 1500;
  const out = fresh("out") ? V.lv.out : flutter(V.saidAt, now);
  const mic = V.muted ? 0 : fresh("mic") ? V.lv.mic : flutter(V.pbAt, now);
  // Eased each frame between the 50 ms readings, so the orbs glide rather than step.
  V.ease.out += (out - V.ease.out) * 0.35; V.ease.mic += (mic - V.ease.mic) * 0.35;
  return { out: V.ease.out, mic: V.ease.mic, raw: out };
}
// How the call's audio held up, for the service log when it ends: lost packets and concealed audio mean the network,
// none means the clicks were made on the phone.
function callHealth() {
  const i = V.health.inbound || {}, p = V.health.pair || {}, num = (x) => (typeof x === "number" && isFinite(x) ? x : undefined);
  return { seconds: Math.round((Date.now() - V.startedAt) / 1000), received: num(i.packetsReceived), lost: num(i.packetsLost), jitterMs: num(i.jitter) !== undefined ? Math.round(i.jitter * 1000) : undefined,
    samples: num(i.totalSamplesReceived), concealed: num(i.concealedSamples), silentConcealed: num(i.silentConcealedSamples), concealments: num(i.concealmentEvents),
    stretched: num(i.insertedSamplesForDeceleration), squeezed: num(i.removedSamplesForAcceleration),
    bufferMs: num(i.jitterBufferDelay) !== undefined && i.jitterBufferEmittedCount ? Math.round((i.jitterBufferDelay / i.jitterBufferEmittedCount) * 1000) : undefined,
    rttMs: num(p.currentRoundTripTime) !== undefined ? Math.round(p.currentRoundTripTime * 1000) : undefined,
    phone: /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "other" };
}
function drawOrbs(now, out, mic, mode) {
  const cv = $("orbs"), g = cv.getContext("2d");
  const w = cv.clientWidth, dpr = Math.min(2, window.devicePixelRatio || 1);
  if (orbView.w !== w) { orbView.w = w; cv.width = cv.height = Math.round(w * dpr); }
  const dt = Math.min(0.05, (now - (orbView.last || now)) / 1000); orbView.last = now;
  const voice = Math.min(1, Math.max(out, mic) * 3);
  if (out > 0.015 || mic > 0.03) orbView.dir = out >= mic ? 1 : -1;
  orbView.lv += (voice - orbView.lv) * 0.25;
  orbView.spin += dt * orbView.dir * (0.12 + 2.4 * orbView.lv) + (mode === "Thinking" ? dt * 0.8 : 0);
  const t = now / 1000, c = w / 2, R = w * 0.31;
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, w);
  const pts = ORBS.map((col, i) => {
    if (!i) return { x: c, y: c, r: w * (0.085 + 0.03 * orbView.lv), col };
    const a = orbView.spin + ((i - 1) / (ORBS.length - 1)) * Math.PI * 2;
    const wave = 0.5 + 0.5 * Math.sin(t * 7 - i * 1.1);
    const chase = mode === "Thinking" ? Math.max(0, Math.cos(a - t * 4)) ** 6 : 0;
    const rr = R * (1 + 0.05 * Math.sin(t * 0.8 + i * 1.7) + 0.1 * orbView.lv * wave);
    return { x: c + Math.cos(a) * rr, y: c + Math.sin(a) * rr, r: w * (0.052 + 0.045 * orbView.lv * wave + 0.025 * chase + (mode === "Speaking" || mode === "Listening" ? 0 : 0.004 * Math.sin(t * 2 + i))), col };
  });
  // The links: each orb to its neighbours and to the one at the heart.
  g.lineWidth = 1.2;
  for (let i = 1; i < pts.length; i++) for (const j of [0, i === pts.length - 1 ? 1 : i + 1]) {
    const p = pts[i], q = pts[j], lg = g.createLinearGradient(p.x, p.y, q.x, q.y);
    lg.addColorStop(0, p.col + "66"); lg.addColorStop(1, q.col + "66");
    g.strokeStyle = lg; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
  }
  for (const p of pts) {
    const glow = g.createRadialGradient(p.x, p.y, p.r * 0.4, p.x, p.y, p.r * 2.6);
    glow.addColorStop(0, p.col + "55"); glow.addColorStop(1, p.col + "00");
    g.fillStyle = glow; g.beginPath(); g.arc(p.x, p.y, p.r * 2.6, 0, Math.PI * 2); g.fill();
    const body = g.createRadialGradient(p.x - p.r * 0.35, p.y - p.r * 0.4, p.r * 0.1, p.x, p.y, p.r);
    body.addColorStop(0, "#ffffffee"); body.addColorStop(0.35, p.col); body.addColorStop(1, p.col + "cc");
    g.fillStyle = body; g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill();
  }
}
function animate() {
  let shown = "";
  const step = (now) => {
    if (!V.pc && !V.idle && !V.waking) { V.raf = 0; return; }
    if (V.idle || (V.waking && !V.pc)) { drawOrbs(now, 0, 0, "Idle"); V.raf = requestAnimationFrame(step); return; }
    const quietFor = Date.now() - Math.max(V.heardAt || 0, V.pbAt || 0, V.saidAt || 0, V.startedAt || 0);
    if (!V.busy && !V.waking && quietFor > IDLE_MS()) { goIdle(); V.raf = requestAnimationFrame(step); return; }
    const { out, mic, raw } = levelsNow(), at = Date.now();
    if (raw > 0.015) V.heardAt = at;
    if (V.busy && at - V.busy > 45000) V.busy = 0; // a backend that never came back
    const mode = at - V.heardAt < 600 ? "Speaking" : V.busy ? "Thinking" : V.muted ? "Muted" : "Listening";
    if (mode !== shown && !V.err) { shown = mode; vstate(mode); }
    drawOrbs(now, out, mic, mode);
    V.raf = requestAnimationFrame(step);
  };
  V.raf = requestAnimationFrame(step);
}
// One microphone for as long as the app is open: an iPhone asks again at every getUserMedia from a home-screen app, so
// it is asked for once, switched off between calls (which stops the capture) and switched back on for the next. A
// stream iOS has ended (the app was put away for long) is asked for again.
let heldMic = null;
async function microphone() {
  if (heldMic && heldMic.getAudioTracks().some((t) => t.readyState === "live")) {
    for (const t of heldMic.getAudioTracks()) t.enabled = true;
    return heldMic;
  }
  // A permission sheet left unanswered never settles: say what's needed rather than spin.
  heldMic = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }), new Promise((_, no) => setTimeout(() => no(new Error("allow the microphone for this page, then tap the mic again")), 15000))]);
  return heldMic;
}
addEventListener("pagehide", (e) => { if (!e.persisted && heldMic) { for (const t of heldMic.getTracks()) t.stop(); heldMic = null; } });
async function openVoice() {
  const box = $("voice"); box.classList.add("on"); box.setAttribute("aria-hidden", "false");
  vtool(""); V.err = 0; proposals.clear(); drawCards();
  const st = $("orbs").parentElement;
  st.querySelector(".secure")?.remove();
  if (!window.isSecureContext || !navigator.mediaDevices) {
    // The microphone needs HTTPS: offer the page's secure link, with the same secret.
    const d = fleetData(), msg = el("div", "secure", d.secure ? "Voice needs the secure link, so your phone lets Fleet hear you." : "Voice needs HTTPS: turn HTTPS on for your tailnet (Tailscale admin → DNS), and fleet serves the page securely.");
    if (d.secure) { const a = el("a", "", "Open the secure link"); a.href = d.secure + "/?t=" + encodeURIComponent(token); msg.append(el("br"), a); }
    st.append(msg); vstate(""); return;
  }
  vstate("Connecting…");
  V.turns = []; V.idleStop = false;
  try {
    V.mic = await microphone();
    await connect(V.mic.getAudioTracks()[0], "");
  } catch (x) { closeVoice(false); V.err = 1; vstate("Couldn't start: " + (x && x.message || x)); }
}
// A GPT-Live call carrying "track": the live microphone, or (waking from idle) the buffered speech first. "recap" is the
// conversation so far, so a call that went idle carries straight on.
async function connect(track, recap) {
  {
    const pc = (V.pc = new RTCPeerConnection());
    const audio = new Audio(); audio.autoplay = true; audio.playsInline = true;
    pc.ontrack = (e) => { audio.srcObject = e.streams[0]; audio.play().catch(() => {}); };
    pc.addTrack(track, V.mic);
    V.dc = pc.createDataChannel("oai-events");
    V.dc.onmessage = onVoiceEvent;
    await pc.setLocalDescription(await pc.createOffer());
    // The whole offer, candidates and all, goes in the one request.
    await new Promise((ok) => { if (pc.iceGatheringState === "complete") return ok(); const done = () => pc.iceGatheringState === "complete" && ok(); pc.addEventListener("icegatheringstatechange", done); setTimeout(ok, 2500); });
    const r = await fleetPost("api/voice/session", { sdp: pc.localDescription.sdp, voice: chosenVoice(), recap });
    if (!r.ok) throw new Error(r.error || "no answer");
    $("vpick").setAttribute("aria-label", "Fleet's voice: " + cap(r.voice) + ". Choose another");
    await pc.setRemoteDescription({ type: "answer", sdp: r.sdp });
    V.startedAt = Date.now(); V.poll = setInterval(pollLevels, 50);
    V.busy = Date.now();
    if (!V.raf) animate();
  }
}

// ── Idle: a minute with nobody speaking ends the call (GPT-Live bills by the second it is open), but the microphone stays
// open. Speech wakes it: what is said from just before it started is kept, a new call starts with a recap of this one,
// and the kept speech goes in first, then the live microphone at the next pause. The phone's audio engine is used only
// while idle, and put away once the live microphone is back, so a call itself never runs through it.
const IDLE_MS = () => window.__fleetIdleMs || 60000;
const recapOf = () => (V.turns || []).map((t) => t.who + ": " + t.text.trim()).filter((l) => l.length > 6).join(" / ").slice(-6000);
function note(who, delta) {
  const turns = (V.turns = V.turns || []);
  const last = turns[turns.length - 1];
  if (last && last.who === who) last.text += delta; else turns.push({ who, text: delta });
  if (turns.length > 60) turns.shift();
}
function goIdle() {
  V.idle = true; V.idleRecap = recapOf();
  if (V.dc && V.dc.readyState === "open") vsend({ type: "session.close", event_id: "idle" });
  if (V.pc && V.startedAt) void fleetPost("api/voice/health", callHealth());
  try { V.dc && V.dc.close(); } catch {} try { V.pc && V.pc.close(); } catch {}
  clearInterval(V.poll);
  Object.assign(V, { pc: null, dc: null, energy: {}, lvAt: {}, health: {}, startedAt: 0, busy: 0, deleg: false, heardAt: 0, saidAt: 0, pbAt: 0 });
  V.calls.clear();
  vstate(V.muted ? "Idle · unmute to talk" : "Idle · just talk"); vtool("");
  listen();
}
// While idle: the last second of the microphone kept, and speech (a few loud frames in a row) wakes the call.
function listen() {
  try {
    const ctx = (V.actx = V.actx || new (window.AudioContext || window.webkitAudioContext)());
    void ctx.resume();
    const src = ctx.createMediaStreamSource(V.mic), proc = ctx.createScriptProcessor(2048, 1, 1), dest = ctx.createMediaStreamDestination();
    src.connect(proc); proc.connect(dest);
    const L = (V.listen = { ctx, src, proc, dest, before: [], queue: [], capturing: false, draining: false, loud: 0, quiet: 0 });
    proc.onaudioprocess = (e) => {
      const inp = new Float32Array(e.inputBuffer.getChannelData(0));
      let sq = 0; for (let i = 0; i < inp.length; i++) sq += inp[i] * inp[i];
      const loud = Math.sqrt(sq / inp.length) > 0.02 && !V.muted;
      L.loud = loud ? L.loud + 1 : 0; L.quiet = loud ? 0 : L.quiet + 1;
      if (!L.capturing) {
        L.before.push(inp); if (L.before.length > 24) L.before.shift(); // about a second
        if (L.loud >= 3) { L.capturing = true; L.queue.push(...L.before); L.before = []; void wake(); }
      } else if (!L.draining || loud) L.queue.push(inp); // once playing out, pauses are skipped so it catches up
      const out = e.outputBuffer.getChannelData(0);
      if (L.draining && L.queue.length) out.set(L.queue.shift()); else out.fill(0);
      if (L.draining && !L.queue.length && L.quiet >= 8) liveAgain();
    };
  } catch { vstate("Idle · tap the mic to talk again"); }
}
async function wake() {
  const L = V.listen; if (!L) return;
  vstate("Waking…"); V.waking = true; V.idle = false;
  try { await connect(L.dest.stream.getAudioTracks()[0], V.idleRecap || ""); }
  catch (x) { V.waking = false; stopListening(); closeVoice(false); V.err = 1; vstate("Couldn't wake: " + (x && x.message || x)); }
}
// The kept speech has gone in and PB has paused: back to the live microphone, and the audio engine put away.
function liveAgain() {
  const L = V.listen; if (!L || !V.pc) return;
  const sender = V.pc.getSenders().find((x) => x.track && x.track.kind === "audio");
  if (sender && V.mic) void sender.replaceTrack(V.mic.getAudioTracks()[0]);
  V.waking = false;
  stopListening();
}
function stopListening() {
  const L = V.listen; if (!L) return;
  V.listen = null;
  L.proc.onaudioprocess = null;
  try { L.src.disconnect(); L.proc.disconnect(); } catch {}
  void L.ctx.suspend();
}
function closeVoice(hide = true) {
  cancelAnimationFrame(V.raf); V.raf = 0;
  stopListening(); V.idle = false; V.waking = false;
  if (V.actx) { void V.actx.close(); V.actx = null; }
  if (V.dc && V.dc.readyState === "open") vsend({ type: "session.close", event_id: "bye" });
  try { V.dc && V.dc.close(); } catch {} try { V.pc && V.pc.close(); } catch {}
  if (V.mic) for (const t of V.mic.getTracks()) t.enabled = false; // kept, switched off, for the next call
  clearInterval(V.poll);
  if (V.pc && V.startedAt) void fleetPost("api/voice/health", callHealth());
  Object.assign(V, { pc: null, dc: null, mic: null, energy: {}, lvAt: {}, health: {}, startedAt: 0, muted: false, busy: 0, deleg: false, heardAt: 0, err: 0 });
  V.calls.clear();
  $("vmute").className = "";
  if (hide) { $("voice").classList.remove("on"); $("voice").setAttribute("aria-hidden", "true"); showVoices(false); }
  if (latestText) apply(latestText, true);
}
// The voice: chosen in the picker and kept on this phone; fleet's default until then. A voice is set when a call starts,
// so choosing another mid-call starts a fresh call in it.
const cap = (v) => (v ? v[0].toUpperCase() + v.slice(1) : "");
const voices = () => fleetData().voices || { list: [], default: "stone", model: "" };
const hasVoice = (v) => voices().list.some((x) => x.id === v);
function chosenVoice() { let v = ""; try { v = localStorage.getItem("fleet-voice") || ""; } catch {} return hasVoice(v) ? v : voices().default; }
const icon = (name) => $("vicons").content.querySelector("." + name).cloneNode(true); // from the page's own markup
const sampleUrl = (v) => "api/voice/sample?v=" + encodeURIComponent(v) + "&t=" + encodeURIComponent(token);
// One player for every preview: starting one replaces whatever was playing, so two never sound at once.
const player = new Audio(); player.preload = "auto";
let sample = null;
function stopSample() { player.pause(); if (sample) { sample.btn.className = "vp"; sample.btn.replaceChildren(icon("play")); sample.btn.setAttribute("aria-label", "Hear " + cap(sample.v)); sample = null; } }
function playSample(v, btn) {
  const same = sample && sample.v === v; stopSample(); if (same) return;
  sample = { v, btn };
  btn.className = "vp wait"; btn.replaceChildren(icon("stop")); btn.setAttribute("aria-label", "Stop " + cap(v));
  player.src = sampleUrl(v); player.currentTime = 0;
  player.play().catch(() => {});
}
player.addEventListener("playing", () => sample && (sample.btn.className = "vp on"));
player.addEventListener("ended", stopSample);
player.addEventListener("error", () => { if (sample && player.src) { const v = sample.v; stopSample(); vtool("Couldn't play " + cap(v)); } });
// The previews are small: fetched once when the menu first opens, so each plays the moment it is tapped.
let warmed = false;
const warmSamples = () => { if (warmed) return; warmed = true; for (const x of voices().list) fetch(sampleUrl(x.id), { priority: "low" }).catch(() => {}); };
function drawVoices() {
  const box = $("vlist"), d = voices(), now = chosenVoice();
  box.replaceChildren(el("div", "vhead", d.model + " · " + d.list.length + " voices"));
  for (const x of d.list) {
    const v = x.id, row = el("div", "vrow"); row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(v === now));
    const pick = el("button", "vn"); pick.append(el("b", "", cap(v)), el("small", "", x.about || ""));
    const play = el("button", "vp"); play.append(icon("play")); play.setAttribute("aria-label", "Hear " + cap(v));
    if (sample && sample.v === v) { sample.btn = play; play.className = player.paused ? "vp wait" : "vp on"; play.replaceChildren(icon("stop")); }
    pick.addEventListener("click", () => chooseVoice(v));
    play.addEventListener("click", (e) => { e.stopPropagation(); playSample(v, play); });
    row.append(pick, play); box.append(row);
  }
}
function showVoices(open) {
  $("vlist").hidden = !open; $("vpick").setAttribute("aria-expanded", String(open));
  if (open) { warmSamples(); drawVoices(); const on = $("vlist").querySelector('[aria-selected="true"]'); if (on) on.scrollIntoView({ block: "nearest" }); } else stopSample();
}
function chooseVoice(v) {
  const was = chosenVoice();
  try { localStorage.setItem("fleet-voice", v); } catch {}
  showVoices(false);
  if (v !== was && V.pc) { vtool("Switching to " + cap(v) + "…"); closeVoice(false); openVoice(); }
}
$("vpick").addEventListener("click", (e) => { e.stopPropagation(); showVoices($("vlist").hidden); });
$("vlist").addEventListener("click", (e) => e.stopPropagation());
$("voice").addEventListener("click", () => !$("vlist").hidden && showVoices(false));
// Masonry on a wide screen: each card, in order, goes into whichever column is shortest, so the most pressing cards
// run along the top and nothing leaves a gap. Laid out again when a card changes size (a chat opened, a reply arrived)
// or the window does. Cards are placed with left and top, since a swipe moves them with transform.
const wide = matchMedia("(min-width:1100px)");
let layoutAsked = 0;
function layoutCards() {
  const box = $("cards"), items = [...box.children];
  if (!wide.matches || view !== "cards") {
    if (box.classList.contains("masonry")) { box.classList.remove("masonry"); box.style.height = ""; for (const c of items) c.style.left = c.style.top = c.style.width = ""; }
    return;
  }
  box.classList.add("masonry");
  const W = box.clientWidth, gap = 14, n = Math.max(1, Math.floor((W + gap) / (520 + gap))), cw = (W - gap * (n - 1)) / n;
  const tops = new Array(n).fill(0);
  for (const c of items) {
    if (!c.classList.contains("card")) {
      // Anything else (a button, a note) spans the width below everything so far.
      const y = Math.max(...tops);
      Object.assign(c.style, { left: "0px", top: y + "px", width: W + "px" });
      tops.fill(y + c.offsetHeight + gap);
      continue;
    }
    c.style.width = cw + "px";
    const k = tops.indexOf(Math.min(...tops));
    c.style.left = k * (cw + gap) + "px";
    c.style.top = tops[k] + "px";
    tops[k] += c.offsetHeight + gap;
  }
  box.style.height = Math.max(0, Math.max(...tops) - gap) + "px";
}
const relayout = () => { if (!layoutAsked) layoutAsked = requestAnimationFrame(() => { layoutAsked = 0; layoutCards(); }); };
const sized = new ResizeObserver(relayout);
new MutationObserver(() => { for (const c of $("cards").children) sized.observe(c); relayout(); }).observe($("cards"), { childList: true });
addEventListener("resize", relayout);
wide.addEventListener("change", relayout);
// ── The view, kept on this device: cards (everything), timeline (activity across the window), compact (a line a session) ──
const VIEWS = ["cards", "timeline", "lanes", "orbit", "compact"];
const ONE_SCREEN = ["timeline", "lanes", "orbit"]; // never scroll: what does not fit is named on a line instead
let view = "cards";
try { const v = localStorage.getItem("fleet-view"); if (VIEWS.includes(v)) view = v; } catch {}
// A link can name the view (&view=timeline), for a screen on the wall that should always open on it.
{ const v = new URLSearchParams(location.search).get("view"); if (VIEWS.includes(v)) view = v; }
function setView(v) {
  if (view === "orbit" && v !== "orbit") orbitStop();
  view = v;
  try { localStorage.setItem("fleet-view", v); } catch {}
  for (const x of VIEWS) document.body.classList.toggle(x, x === v);
  document.body.classList.toggle("onescreen", ONE_SCREEN.includes(v));
  if (latestText) apply(latestText, true);
}
// ── Timeline: the CLI's timeline (key 3) on the whole browser width ──
// Every card's charts share one scale, as the terminal's far cards do, so a busy session looks busier than a quiet one.
let tl = { tools: 1, out: 1, axis: undefined, data: new Map() };
function timelineScale(d) {
  const all = (d.sessions || []).filter((s) => s.timeline);
  tl = { tools: Math.max(1, ...all.flatMap((s) => s.timeline.tools)), out: Math.max(1, ...all.flatMap((s) => s.timeline.out)), axis: d.timeline, data: new Map(all.map((s) => [s.sid, s.timeline])) };
}
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const agoText = (min) => (min >= 120 ? Math.round(min / 60) + "h" : min >= 60 ? (min / 60).toFixed(1).replace(".0", "") + "h" : Math.round(min) + "m");
const MARKS = { "▸": "you typed to it", "⇡": "it linked a pull request", "≡": "a workflow started", "◇": "a workflow started", "✓": "a task finished" };
// How many cards fit on the screen at their least height (what is left under the header, between the gaps), keeping a
// line for the rest when not all do. Worked out again when that room changes size.
const TL_MIN = () => (innerWidth < 600 ? 104 : 116), TL_GAP = 10, TL_MORE = 26;
let tlFit = -1, tlCount = 0, tlCols = 1;
function timelineFit(n) {
  tlCount = n;
  const box = $("cards"), room = box.clientHeight, min = TL_MIN();
  // Two columns on a wide screen when one would make the cards short: each chart keeps a height worth reading.
  tlCols = box.clientWidth >= 1400 && n > 1 && (room - (n - 1) * TL_GAP) / n < 220 ? 2 : 1;
  const rows = (k) => Math.ceil(k / tlCols);
  const fits = (k, more) => rows(k) * min + (rows(k) - 1) * TL_GAP + (more ? TL_MORE + TL_GAP : 0) <= room;
  let fit = n;
  if (room && !fits(n, false)) for (fit = 1; fit + 1 < n && fits(fit + 1, true); ) fit++;
  box.style.setProperty("--cols", tlCols);
  box.style.gridTemplateRows = "repeat(" + Math.max(1, rows(fit)) + ",minmax(0,1fr))" + (fit < n ? " auto" : "");
  return (tlFit = fit);
}
new ResizeObserver(() => {
  if (view === "lanes" && latestText) return void apply(latestText, true); // its rows are cut to the room it has
  if (view !== "timeline" || !latestText) return;
  const was = [tlFit, tlCols];
  if (timelineFit(tlCount) !== was[0] || tlCols !== was[1]) apply(latestText, true);
}).observe($("cards"));
function timelineChart(s) {
  const t = s.timeline, n = t.tools.length || 1, BW = 10, H = 100, top = 84; // bars rise to 84%, leaving the legend room
  const colour = s.state === "needs" ? "#e5b544" : s.state === "stalled" ? "#f0625c" : "#61aaff";
  const svg = svgEl("svg", { class: "tch", viewBox: "0 0 " + n * BW + " " + H, preserveAspectRatio: "none" });
  for (const y of [H - top, H - top / 2]) svg.append(svgEl("line", { x1: 0, x2: n * BW, y1: y, y2: y, stroke: "#262d37", "stroke-width": "1", "stroke-dasharray": "3 4", "vector-effect": "non-scaling-stroke" }));
  // Tool calls a bar each, the bar still filling brightest; every bar drawn, so a card updates in place.
  t.tools.forEach((v, i) => {
    const h = v ? Math.max(2, (v / tl.tools) * top) : 0;
    svg.append(svgEl("rect", { x: i * BW + 1, y: H - h, width: BW - 2, height: h, rx: "1.5", fill: colour, "fill-opacity": i === n - 1 ? "1" : ".62" }));
  });
  // Output tokens as a line over them, on its own scale.
  const pts = t.out.map((v, i) => [i * BW + BW / 2, H - 1 - (v / tl.out) * top]);
  svg.append(svgEl("path", { d: pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" "), fill: "none", stroke: "#be94ff", "stroke-width": "1.5", "stroke-opacity": ".9", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" }));
  const wrap = el("div", "twrap");
  const leg = el("div", "tleg");
  const k1 = el("span"); const i1 = el("i"); i1.style.background = colour; k1.append(i1, "tool calls");
  const k2 = el("span"); const i2 = el("i", "ln"); i2.style.background = "#be94ff"; k2.append(i2, "output tokens");
  leg.append(k1, k2);
  const cur = el("div", "tcur"), tip = el("div", "ttip");
  wrap.append(svg, leg, cur, tip);
  // Hovering a bar says when it was and what happened in it, from the latest figures (the card is patched in place).
  wrap.addEventListener("mousemove", (e) => {
    const now = tl.data.get(s.sid), ax = tl.axis;
    if (!now || !ax) return;
    const r = svg.getBoundingClientRect(), N = now.tools.length, i = Math.max(0, Math.min(N - 1, Math.floor(((e.clientX - r.left) / r.width) * N)));
    const barMs = (ax.end - ax.start) / N, at = new Date(ax.start + i * barMs);
    const when = at.toLocaleTimeString([], barMs < 60000 ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
    tip.textContent = when + " · " + now.tools[i] + " tool call" + (now.tools[i] === 1 ? "" : "s") + " · " + kfmt(now.out[i]) + " out";
    const x = ((i + 0.5) / N) * r.width;
    cur.style.left = x + "px"; cur.style.display = "block";
    tip.style.display = "block"; tip.style.left = Math.max(0, Math.min(r.width - tip.offsetWidth, x - tip.offsetWidth / 2)) + "px";
  });
  wrap.addEventListener("mouseleave", () => { cur.style.display = tip.style.display = "none"; });
  // Under the chart, what happened when.
  const marks = el("div", "tmk");
  for (const m of t.marks) { const g = el("span", "", m.g); g.style.left = ((m.i + 0.5) / n) * 100 + "%"; g.style.color = m.c; g.title = MARKS[m.g] || ""; marks.append(g); }
  const axis = el("div", "tax"), min = (tl.axis && tl.axis.minutes) || 30;
  for (const f of [0, 1 / 3, 2 / 3, 1]) { const a = el("span", "", f === 1 ? "now" : agoText(min * (1 - f)) + (f ? "" : " ago")); a.style.left = f * 100 + "%"; axis.append(a); }
  const box = el("div", "tchart"); box.append(wrap, marks, axis);
  return box;
}
function timelineCard(s) {
  const receded = s.state === "yourTurn" || s.state === "idle" || s.state === "finished";
  const c = el("section", "tcard" + (s.state === "needs" ? " needs" : "") + (receded ? " receded" : "")); c.style.setProperty("--c", s.color);
  c.title = "Open " + s.name + (isDone(s) ? " · swipe to put away" : "");
  c.addEventListener("click", tapped(() => openFocus(s.sid)));
  if (isDone(s) && !putAway()[s.sid]) { c.classList.add("done"); swipeAway(c, s.sid); }
  // The name in letter-spaced capitals; the state, its glyph first, on the right.
  const th = el("div", "th"), st = el("div", "tst", (s.glyph ? s.glyph + " " : "") + s.word);
  if (s.time) st.append(el("small", "", s.time));
  th.append(el("div", "tn", s.name), st);
  c.append(th);
  if (s.place) c.append(el("div", "tpl", s.place));
  // What it is doing, or asking: the question, your prompt (▸) or Claude's reply (◆), as the CLI's subheading.
  const sub = el("div", "tsub");
  if (s.sub.source === "prompt") sub.append(el("span", "you", "▸ ")); else if (s.sub.source === "reply") sub.append(el("span", "cl", "◆ "));
  sub.append(s.sub.text || "");
  c.append(sub);
  if (!s.timeline) return c;
  const t = s.timeline, body = el("div", "tbody"), side = el("div", "tside");
  // One fact a row, each with its priority: a short card gives up p4 first, then p3, p2 (see the ladder in the stylesheet).
  const line = (p, ...parts) => { const r = el("div", p); r.append(...parts); side.append(r); return r; };
  const nA = s.agents.length, nW = s.workflows.length;
  const ag = el("span", nA ? "live" : "", (nA ? "● " : "○ ") + nA + " agent" + (nA === 1 ? "" : "s"));
  line("p1", ag, ...(nW ? ["   ", el("span", "wf", "≡ " + nW + " workflow" + (nW === 1 ? "" : "s"))] : []));
  if (s.ctx) {
    const gg = el("span", "gg"), fill = el("i"); fill.style.width = s.ctx.pct + "%"; fill.style.background = tone(s.ctx.pct); gg.append(fill);
    const pct = el("b", "", s.ctx.pct + "%"); pct.style.color = tone(s.ctx.pct);
    line("p1", el("span", "k", "CTX"), gg, pct, " of " + s.ctx.max + (s.ctx.runway ? " · " + s.ctx.runway : ""));
  }
  line("p4", el("span", "k", "CPU"), el("b", "", t.cpu + "%"), t.mem ? " · " + t.mem : "");
  const tools = t.tools.reduce((a, b) => a + b, 0), out = t.out.reduce((a, b) => a + b, 0);
  line("p3", el("span", "k", "USE"), el("b", "", kfmt(tools)), " tool calls · ", el("b", "", kfmt(out)), " out" + (tl.axis ? " / " + agoText(tl.axis.minutes) : ""));
  if (s.tasks && s.tasks.total) {
    const T = s.tasks, doing = T.open.filter((x) => x.status === "in_progress").length, n = Math.min(20, T.total), bar = el("span", "tbar");
    // One pip a task (scaled to 20 at most): done in green, in progress in white.
    const dn = Math.round((T.done / T.total) * n), dg = Math.min(n - dn, Math.ceil((doing / T.total) * n));
    for (let i = 0; i < n; i++) bar.append(el("i", i < dn ? "d" : i < dn + dg ? "n" : ""));
    line("p2", el("span", "k", "TASKS"), bar, el("b", "", T.done + "/" + T.total));
  }
  body.append(timelineChart(s), side);
  c.append(body);
  return c;
}
// The sessions that do not fit a one-screen view, on one line: those waiting on you first, in amber.
function moreLine(rest) {
  rest = [...rest].sort((a, b) => (b.state === "needs") - (a.state === "needs"));
  const waiting = rest.filter((s) => s.state === "needs").length;
  const more = el("div", "tmore"); more.append(el("b", "", "… " + rest.length + " more"));
  if (waiting) more.append(" · ", el("em", "", waiting + " need" + (waiting === 1 ? "s" : "") + " you"));
  more.append(": ");
  rest.forEach((s, i) => { if (i) more.append(", "); more.append(el("span", s.state === "needs" ? "nd" : "", s.name + " (" + s.word.toLowerCase() + ")")); });
  return more;
}
// ── Lanes: every session on one time axis, a row each, like a CI run's waterfall ──
// A cell a bar of the window, as bright as that bar was busy (on one scale for every row), the marks of what happened
// on it; so what ran side by side, what sat quiet and when everything stopped read at a glance. One screen: rows share
// the height, as many as fit at their least, the rest named on a line.
const LANE_MIN = 24;
function lanesBoard(shown) {
  const box = el("div", "lanes"), ax = tl.axis, min = (ax && ax.minutes) || 30;
  const room = $("cards").clientHeight - 28;
  const fit = !room || shown.length * LANE_MIN <= room ? shown.length : Math.max(1, Math.floor((room - 26) / LANE_MIN));
  const head = el("div", "lrow lhead"), axis = el("div", "llane lax");
  for (const f of [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1]) { const a = el("span", "", f === 1 ? "now" : agoText(min * (1 - f)) + (f ? "" : " ago")); a.style.left = f * 100 + "%"; axis.append(a); }
  head.append(el("div", "lname", shown.length + " session" + (shown.length === 1 ? "" : "s")), axis, el("div", "lfig", "tools · out"));
  box.append(head);
  for (const s of shown.slice(0, fit)) {
    const r = el("div", "lrow" + (s.state === "needs" ? " needs" : "")); r.style.setProperty("--c", s.color); r.dataset.sid = s.sid;
    r.title = "Open " + s.name;
    r.addEventListener("click", tapped(() => openFocus(s.sid)));
    const nm = el("div", "lname"); nm.append(el("b", "", s.name), el("small", "", (s.glyph ? s.glyph + " " : "") + s.word.toLowerCase() + (s.time ? " · " + s.time : "")));
    const lane = el("div", "llane"), fig = el("div", "lfig");
    if (s.timeline) {
      const t = s.timeline, n = t.tools.length || 1;
      const svg = svgEl("svg", { viewBox: "0 0 " + n + " 1", preserveAspectRatio: "none" });
      t.tools.forEach((v, i) => svg.append(svgEl("rect", { x: i + 0.08, y: 0, width: 0.84, height: 1, rx: "0.15", fill: s.color, "fill-opacity": v ? (0.28 + 0.72 * Math.sqrt(v / tl.tools)).toFixed(2) : "0.06" })));
      lane.append(svg);
      for (const m of t.marks) { const g = el("span", "lm", m.g); g.style.left = ((m.i + 0.5) / n) * 100 + "%"; g.style.color = m.c; g.title = MARKS[m.g] || ""; lane.append(g); }
      fig.append(el("b", "", kfmt(t.tools.reduce((a, b) => a + b, 0))), " · " + kfmt(t.out.reduce((a, b) => a + b, 0)));
    }
    r.append(nm, lane, fig);
    box.append(r);
  }
  if (fit < shown.length) box.append(moreLine(shown.slice(fit)));
  return box;
}
// ── Needs you: every session waiting on you, its question and its choices, above every view but the cards (whose
// waiting card has them) ──
// A choice, Esc or Enter is tapped twice, as on a card; a line typed is sent. It never re-renders under your typing.
function needsStrip(d) {
  const box = $("needs");
  if (box.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  const waiting = view === "cards" || !opts.strip ? [] : (d.sessions || []).filter((s) => s.state === "needs");
  const rows = waiting.slice(0, 3).map((s) => {
    const r = el("div", "nrow"); r.dataset.k = s.sid;
    const nm = el("button", "nname", "▲ " + s.name); nm.type = "button"; nm.title = "Open " + s.name; nm.addEventListener("click", () => openFocus(s.sid));
    const q = el("div", "nq", (s.sub && s.sub.text) || "waiting on you");
    const acts = el("div", "nacts");
    const sc = screens.get(s.sid);
    if (choicesStale(s, sc)) void readScreen(s.sid);
    for (const o of (sc && sc.options) || []) acts.append(armable(s, "k" + o.key, "pick", [el("span", "k", o.key), el("span", "", o.label)], o.key + ". " + o.label, { key: o.key }));
    acts.append(armable(s, "esc", "chip key", ["Esc"], "Esc", { key: "X" }), armable(s, "enter", "chip key", ["Enter"], "Enter", { key: "E" }));
    const f = el("form", "nsend"), inp = el("input"); inp.placeholder = "answer " + s.name + "…"; inp.value = drafts.get(s.sid) || ""; inp.dataset.k = s.sid;
    inp.addEventListener("input", () => drafts.set(s.sid, inp.value));
    const go = el("button", "", "Send"); go.type = "submit"; f.append(inp, go);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = inp.value.trim(); if (!text) return;
      notes.set(s.sid, { cls: "", text: "sending…" }); inp.blur(); tick();
      const res = await post("api/send", { sid: s.sid, text });
      if (res.ok) drafts.delete(s.sid);
      notes.set(s.sid, res.ok ? { cls: "ok", text: (res.queued ? "queued ⏳" : "sent ✓") } : { cls: "err", text: "not sent: " + (res.error || "unknown") });
      screens.delete(s.sid); tick();
    });
    acts.append(f);
    const note = notes.get(s.sid); if (note && note.text) acts.append(el("span", "nnote " + (note.cls || ""), note.text));
    r.append(nm, q, acts);
    return r;
  });
  if (waiting.length > 3) rows.push(el("div", "nmore", "+ " + (waiting.length - 3) + " more waiting on you"));
  const fresh = el("div", "needs-strip"); fresh.id = "needs"; fresh.append(...rows);
  if (shapeOf(box) === shapeOf(fresh)) patch(box, fresh); else box.replaceChildren(...rows);
}
// ── Eating the five hours: each session's share of the output since the window began ──
const BURN_COLOURS = ["#61aaff", "#be94ff", "#56cdd6", "#e5b544", "#50c878", "#f08c5c", "#f5a3c7", "#9fb3c8"];
const hashOf = (text) => { let h = 0; for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
function burnPanel(b) {
  const box = $("burn");
  if (!b || !b.total || !opts.burn) return void box.replaceChildren();
  const since = new Date(b.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const head = el("div", "bh"); head.append(el("b", "", "Eating the 5 hours"), el("span", "", kfmt(b.total) + " tokens out since " + since));
  const bar = el("div", "bbar"), leg = el("div", "bleg"), used = new Set();
  // A colour a session, from its id, so it keeps its colour as the order changes.
  const colourOf = (sid) => { let i = hashOf(sid) % BURN_COLOURS.length; while (used.has(i) && used.size < BURN_COLOURS.length) i = (i + 1) % BURN_COLOURS.length; used.add(i); return BURN_COLOURS[i]; };
  const part = (name, out, colour) => {
    const pct = (out / b.total) * 100, seg = el("i"); seg.style.width = pct + "%"; seg.style.background = colour; seg.title = name + ": " + Math.round(pct) + "% · " + kfmt(out) + " out"; bar.append(seg);
    const k = el("span", "bk"), dot = el("i"); dot.style.background = colour; k.append(dot, name + " ", el("b", "", (pct < 1 ? "<1" : Math.round(pct)) + "%")); leg.append(k);
  };
  for (const x of b.top) part(x.name, x.out, colourOf(x.sid));
  if (b.rest) part(b.others + " other" + (b.others === 1 ? "" : "s"), b.rest, "#3a4250");
  box.replaceChildren(head, bar, leg);
}
// ── Badges: how many wait on you, on the installed app's icon (where the browser can) and on the tab's icon ──
let badgeWas = -1;
const iconWas = new Map();
function badge(n, force) {
  if (!opts.badge) n = 0;
  if (n === badgeWas && !force) return;
  badgeWas = n;
  try { if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch {}
  const links = [...document.querySelectorAll('link[rel="icon"]')];
  for (const l of links) if (!iconWas.has(l)) iconWas.set(l, l.href);
  if (!n) { for (const l of links) l.href = iconWas.get(l); return; }
  const img = new Image();
  img.onload = () => {
    if (badgeWas !== n) return;
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0, 64, 64);
    g.beginPath(); g.arc(44, 20, 19, 0, Math.PI * 2); g.fillStyle = "#e5b544"; g.fill(); g.lineWidth = 3; g.strokeStyle = "#0d1117"; g.stroke();
    g.fillStyle = "#1a1300"; g.font = "bold 26px -apple-system,system-ui,sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(n > 9 ? "9+" : String(n), 44, 21);
    const url = c.toDataURL("image/png");
    for (const l of links) l.href = url;
  };
  img.src = "/icon-192.png";
}
// ── Orbit: the whole fleet in motion, in 3D (web/orbit.js, on three.js) ──
// One element, kept: the scene is made once and fed each new state, never rebuilt. Its code loads the first time.
let orbitBox = null, orbitMod = null, orbitLoading = null, orbitData = null;
function orbitHost(d) {
  orbitData = d;
  if (!orbitBox) { orbitBox = el("div", "orbit"); orbitBox.append(el("div", "orbit-note", "Lighting up the fleet…")); }
  if (orbitMod) orbitMod.update(d);
  else if (!orbitLoading)
    orbitLoading = import("/orbit.js").then((m) => {
      orbitMod = m;
      orbitBox.replaceChildren();
      m.mount(orbitBox, { open: (sid) => openFocus(sid) });
      if (orbitData) m.update(orbitData);
    }).catch((e) => { orbitLoading = null; orbitBox.replaceChildren(el("div", "orbit-note", "The orbit view could not start: " + (e && e.message ? e.message : e))); });
  return orbitBox;
}
function orbitStop() {
  if (orbitMod) orbitMod.unmount();
  orbitMod = null; orbitLoading = null; orbitBox = null;
}
function compactRow(s) {
  const r = el("div", "crow" + (s.state === "needs" ? " needs" : "")); r.style.setProperty("--c", s.color);
  const n = el("div", "rn"); n.append(el("b", "", s.name), el("small", "", s.place || ""));
  const doing = (s.sub && s.sub.text) || s.word;
  const tail = [s.word + (s.time ? " · " + s.time : ""), s.ctx ? s.ctx.pct + "%" : ""].filter(Boolean).join(" · ");
  r.append(el("span", "dot"), n, el("div", "rs", doing), el("div", "rt", tail));
  r.title = "Open " + s.name + (isDone(s) ? " · swipe to put away" : "");
  r.addEventListener("click", tapped(() => openFocus(s.sid)));
  if (isDone(s) && !putAway()[s.sid]) { r.classList.add("done"); swipeAway(r, s.sid); }
  return r;
}
// The CLI's keys: 1 cards (detail), 2 compact, 3 timeline. Not while you type, nor over a sheet or the focus view.
addEventListener("keydown", (e) => {
  const v = { 1: "cards", 2: "compact", 3: "timeline", 4: "lanes", 5: "orbit" }[e.key];
  if (!v || e.metaKey || e.ctrlKey || e.altKey || /^(TEXTAREA|INPUT|SELECT)$/.test((document.activeElement || {}).tagName || "")) return;
  if (focusSid || $("newsheet").classList.contains("on") || $("voice").classList.contains("on")) return;
  setView(v);
});
for (const x of VIEWS) document.body.classList.toggle(x, x === view);
document.body.classList.toggle("onescreen", ONE_SCREEN.includes(view));

// ── The focus view: one session with everything open, and what its own terminal shows ──
let focusSid = null;
const sessionNow = (sid) => (fleetData().sessions || []).find((x) => x.sid === sid);
// The focus view's terminal is read when it opens, then only when the session has moved on (a message, a state), at
// most every 15 s, or on ↻: never on a timer, since reading a background session's screen makes it redraw (see
// readScreen).
let focusSig = "", focusReadAt = 0;
const focusSigOf = (s) => (s ? s.state + "|" + ((s.sub && s.sub.text) || "") + "|" + (s.talk && s.talk.length ? s.talk[s.talk.length - 1].t : "") : "");
function renderFocus() {
  if (!focusSid) return;
  const s = sessionNow(focusSid), box = $("fcard");
  const sig = focusSigOf(s);
  if (s && sig !== focusSig && Date.now() - focusReadAt > 15000) { focusSig = sig; focusReadAt = Date.now(); void readFocusScreen(); }
  if (!s) { $("fname").textContent = "That session has gone"; return; }
  $("fname").textContent = s.name;
  if (box.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA") return; // never under your typing
  const was = new Map([...box.querySelectorAll("details")].map((d) => [d.className, d.open]));
  const c = card(s); c.dataset.sid = s.sid;
  for (const d of c.querySelectorAll("details")) d.open = was.has(d.className) ? was.get(d.className) : true;
  box.replaceChildren(c);
}
// The focus view's terminal, read every few seconds. (Its own name: as readScreen, it replaced the one that reads a
// waiting session's choices, which then never came.)
async function readFocusScreen() {
  if (!focusSid) return;
  const r = await fleetPost("api/screen", { sid: focusSid });
  if (!focusSid) return;
  $("fscreen").textContent = r.ok ? r.screen || "(empty)" : "Can't see its screen: " + (r.error || "unknown");
  $("fsat").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function openFocus(sid) {
  focusSid = sid;
  $("focus").classList.add("on"); $("focus").setAttribute("aria-hidden", "false");
  $("fcard").replaceChildren(); $("fscreen").textContent = "reading its screen…";
  renderFocus(); readFocusScreen();
  focusSig = focusSigOf(sessionNow(sid)); focusReadAt = Date.now();
}
function closeFocus() {
  focusSid = null;
  $("focus").classList.remove("on"); $("focus").setAttribute("aria-hidden", "true");
}
$("fback").addEventListener("click", closeFocus);
$("fsrefresh").addEventListener("click", () => { focusReadAt = Date.now(); void readFocusScreen(); });
addEventListener("keydown", (e) => { if (e.key === "Escape") { if (focusSid) closeFocus(); else if ($("newsheet").classList.contains("on")) closeNew(); } });

// ── Starting a session: which machine (asked first), which folder, what to ask ──
let newPick = {};
function closeNew() { $("newsheet").classList.remove("on"); $("newsheet").setAttribute("aria-hidden", "true"); }
function newStep() {
  const body = $("newbody"), places = fleetData().places || [];
  const hosts = [...new Set(places.map((p) => p.host))];
  const opt = (label, small, go) => { const b = el("button", "opt"); b.type = "button"; b.append(el("span", "", label), el("small", "", small)); b.addEventListener("click", go); return b; };
  const back = (to) => { const b = el("button", "backlink", "‹ " + to); b.type = "button"; b.addEventListener("click", () => { if (to === "Machines") newPick = {}; else newPick.cwd = undefined; newStep(); }); return b; };
  if (!places.length) return body.replaceChildren(el("div", "note", "Nothing to start in yet: fleet offers the folders your sessions run in."));
  if (!newPick.host) {
    $("newtitle").textContent = "Start a session";
    const grid = el("div", "opts");
    for (const h of hosts) grid.append(opt(h, places.filter((p) => p.host === h).length + " folders", () => { newPick = { host: h }; newStep(); }));
    return body.replaceChildren(el("div", "step", "Which machine?"), grid);
  }
  if (!newPick.cwd) {
    $("newtitle").textContent = "On " + newPick.host;
    const grid = el("div", "opts");
    for (const p of places.filter((x) => x.host === newPick.host)) grid.append(opt(p.place, p.cwd.replace(/^\/Users\/[^/]+/, "~"), () => { newPick.cwd = p.cwd; newPick.place = p.place; newStep(); }));
    return body.replaceChildren(...(hosts.length > 1 ? [back("Machines")] : []), el("div", "step", "Which folder?"), grid);
  }
  $("newtitle").textContent = "In " + newPick.place;
  const ta = el("textarea"); ta.placeholder = "What should it do?";
  const go = el("button", "go", "Start"); go.type = "button";
  const note = el("div", "note", "On " + newPick.host + ", in " + newPick.cwd.replace(/^\/Users\/[^/]+/, "~"));
  go.addEventListener("click", async () => {
    const prompt = ta.value.trim(); if (!prompt) return ta.focus();
    go.disabled = true; note.className = "note"; note.textContent = "Starting…";
    const r = await fleetPost("api/new", { host: newPick.host, cwd: newPick.cwd, prompt });
    if (r.ok) { note.className = "note ok"; note.textContent = "Started" + (r.id ? " (" + r.id + ")" : "") + " on " + newPick.host + ": it shows here in a moment."; setTimeout(closeNew, 1800); }
    else { note.className = "note bad"; note.textContent = "Not started: " + (r.error || "unknown"); go.disabled = false; }
  });
  body.replaceChildren(back("Folders"), el("div", "step", "What should it do?"), ta, go, note);
  setTimeout(() => ta.focus(), 50);
}
$("newbtn").addEventListener("click", () => {
  const hosts = [...new Set((fleetData().places || []).map((p) => p.host))];
  newPick = hosts.length === 1 ? { host: hosts[0] } : {};
  newStep();
  $("newsheet").classList.add("on"); $("newsheet").setAttribute("aria-hidden", "false");
});
$("newx").addEventListener("click", closeNew);
// ── The menu (⋯): the views by name, starting a session, and the options, kept on this device ──
// ── Options (from the menu): which parts of the page show, how it tells you something waits, and the screen ──
// Kept on this device. The parts are hidden by a class on the page, so nothing else has to know.
const OPT_DEFAULTS = { quip: true, strip: true, pulse: true, gauges: true, five: true, burn: true, accounts: true, foot: true, badge: true, chime: false, notify: false, awake: false, dim: false, calm: false };
let opts = { ...OPT_DEFAULTS };
try { opts = { ...OPT_DEFAULTS, ...JSON.parse(localStorage.getItem("fleet-opts") || "{}") }; } catch {}
const OPTION_GROUPS = [
  ["Show", [
    ["quip", "Status line", "How the fleet is doing, in a line under the title"],
    ["strip", "Needs you strip", "The sessions waiting on you, answerable, above every view but the cards"],
    ["pulse", "Fleet pulse", "Tool calls across every machine, a bar a minute for the last hour"],
    ["gauges", "Gauges", "The five-hour and weekly limits, CPU and memory, as rings"],
    ["five", "Five-hour forecast", "When the five-hour limit runs out, or where it will be at the reset"],
    ["burn", "Eating the 5 hours", "Each session's share of the output since the window began"],
    ["accounts", "Accounts", "Every account's limits, and the machines on each"],
    ["foot", "Footer", "What is hidden, and whether the page is live"],
  ]],
  ["Tell me", [
    ["badge", "Badge the icon", "How many wait on you, on the app's icon and the tab's"],
    ["chime", "Chime", "A soft two notes when a session starts waiting on you"],
    ["notify", "Notification", "A system notification when a session starts waiting on you; a tap opens it"],
  ]],
  ["Screen", [
    ["awake", "Keep the screen awake", "For a screen on the wall: it never sleeps while this page is open"],
    ["dim", "Dim at night", "Darker from 22:00 to 07:00"],
    ["calm", "Calm motion", "No glowing or pulsing, and the orbit view slowed"],
  ]],
];
const SECTIONS = ["quip", "strip", "pulse", "gauges", "five", "burn", "accounts", "foot"];
const VIEW_NAMES = { cards: ["Cards", "1", "everything about each session"], compact: ["Compact", "2", "a line a session"], timeline: ["Timeline", "3", "activity across the window, one screen"], lanes: ["Lanes", "4", "every session on one time axis, one screen"], orbit: ["Orbit", "5", "the whole fleet in motion, in 3D"] };
function applyOpts() {
  for (const k of SECTIONS) document.body.classList.toggle("hide-" + k, !opts[k]);
  document.body.classList.toggle("calm", !!opts.calm);
  const h = new Date().getHours();
  document.body.classList.toggle("dim", !!opts.dim && (h >= 22 || h < 7));
  keepAwake();
}
async function setOpt(k, on) {
  if (k === "notify" && on && "Notification" in window && Notification.permission !== "granted") {
    const p = await Notification.requestPermission().catch(() => "denied");
    if (p !== "granted") { on = false; optNote = "Notifications are blocked for this page: allow them in the browser's site settings."; }
  }
  if (k === "notify" && on && !("Notification" in window)) { on = false; optNote = "This browser has no notifications (on an iPhone, add the page to the home screen first)."; }
  if (k === "awake" && on && !("wakeLock" in navigator)) optNote = "This browser cannot keep the screen awake (it needs the page over HTTPS).";
  opts[k] = on;
  try { localStorage.setItem("fleet-opts", JSON.stringify(opts)); } catch {}
  if (k === "badge" && !on) badge(0, true);
  applyOpts();
  if (latestText) apply(latestText, true);
  renderOptions();
}
// The menu: the views, with their icons and keys; starting a session; the options.
function renderMenu() {
  const m = $("menu"), item = (cls, icon, label, small, right, go) => {
    const b = el("button", "mi " + cls); b.type = "button"; b.setAttribute("role", "menuitem");
    if (icon) { const ic = el("span", "mic"); ic.append(icon); b.append(ic); }
    const t = el("span", "mt"); t.append(el("b", "", label)); if (small) t.append(el("small", "", small));
    b.append(t); if (right) b.append(right);
    b.addEventListener("click", go); return b;
  };
  const icon = (v) => { const svg = $("viewicons").content.querySelector('[data-v="' + v + '"] svg'); return svg ? svg.cloneNode(true) : null; };
  const views = el("div", "mg"); views.append(el("div", "mh", "View"));
  for (const v of VIEWS) { const [name, key, about] = VIEW_NAMES[v] || [v, "", ""]; views.append(item(v === view ? "on" : "", icon(v), name, about, el("kbd", "", key), () => { setView(v); closeMenu(); })); }
  const acts = el("div", "mg"); acts.append(el("div", "mh", "Do"));
  acts.append(item("", null, "Start a session", "in a folder where one already runs", el("kbd", "", "+"), () => { closeMenu(); $("newbtn").click(); }));
  acts.append(item("", null, "Options…", "what shows, alerts, the screen", el("kbd", "", ","), () => { closeMenu(); openOptions(); }));
  m.replaceChildren(views, acts);
}
// The options dialog: a switch an option, in three groups.
let optNote = "";
function renderOptions() {
  const body = $("optbody"), groups = [];
  for (const [title, list] of OPTION_GROUPS) {
    const g = el("div", "og"); g.append(el("div", "mh", title));
    for (const [k, label, about] of list) {
      const b = el("button", "oi"); b.type = "button"; b.setAttribute("role", "switch"); b.setAttribute("aria-checked", String(!!opts[k]));
      const t = el("span", "mt"); t.append(el("b", "", label), el("small", "", about));
      const sw = el("span", "sw" + (opts[k] ? " on" : "")); sw.append(el("i"));
      b.append(t, sw); b.addEventListener("click", () => setOpt(k, !opts[k]));
      g.append(b);
    }
    groups.push(g);
  }
  if (optNote) groups.push(el("div", "note", optNote));
  const reset = el("button", "backlink", "Back to the defaults"); reset.type = "button";
  reset.addEventListener("click", () => { opts = { ...OPT_DEFAULTS }; try { localStorage.removeItem("fleet-opts"); } catch {} optNote = ""; applyOpts(); badge(badgeWas, true); if (latestText) apply(latestText, true); renderOptions(); });
  groups.push(reset);
  body.replaceChildren(...groups);
}
function openOptions() { optNote = ""; renderOptions(); $("optsheet").classList.add("on"); $("optsheet").setAttribute("aria-hidden", "false"); }
function closeOptions() { $("optsheet").classList.remove("on"); $("optsheet").setAttribute("aria-hidden", "true"); }
$("optx").addEventListener("click", closeOptions);
$("optsheet").addEventListener("click", (e) => { if (e.target === $("optsheet")) closeOptions(); });
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("optsheet").classList.contains("on")) closeOptions();
  if (e.key === "," && !e.metaKey && !e.ctrlKey && !/^(TEXTAREA|INPUT|SELECT)$/.test((document.activeElement || {}).tagName || "")) openOptions();
});
// Keep the screen awake while the page shows (the lock lapses when it is hidden, so it is asked for again on return).
let screenLock = null;
async function keepAwake() {
  if (!opts.awake || document.hidden || !("wakeLock" in navigator)) { if (screenLock && !opts.awake) { screenLock.release().catch(() => {}); screenLock = null; } return; }
  if (screenLock && !screenLock.released) return;
  try { screenLock = await navigator.wakeLock.request("screen"); } catch { screenLock = null; }
}
document.addEventListener("visibilitychange", keepAwake);
// When a session starts waiting on you: a chime and a notification, as asked for. Not for those waiting already when
// the page opened.
let waitingWas = null, audio = null;
function newlyWaiting(d) {
  const now = new Set((d.sessions || []).filter((s) => s.state === "needs").map((s) => s.sid));
  const fresh = waitingWas ? [...now].filter((sid) => !waitingWas.has(sid)) : [];
  waitingWas = now;
  if (!fresh.length) return;
  if (opts.chime) chime();
  if (opts.notify && "Notification" in window && Notification.permission === "granted")
    for (const sid of fresh) {
      const s = d.sessions.find((x) => x.sid === sid);
      try { const n = new Notification("▲ " + s.name + " needs you", { body: (s.sub && s.sub.text) || "", tag: "fleet-" + sid, icon: "/icon-192.png" }); n.onclick = () => { window.focus(); openFocus(sid); n.close(); }; } catch {}
    }
}
function chime() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    for (const [f, at] of [[880, 0], [1318.5, 0.16]]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.18, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.6);
      o.start(t + at); o.stop(t + at + 0.65);
    }
  } catch {}
}
function openMenu() { renderMenu(); $("menu").hidden = false; $("menubtn").setAttribute("aria-expanded", "true"); }
function closeMenu() { $("menu").hidden = true; $("menubtn").setAttribute("aria-expanded", "false"); }
$("menubtn").addEventListener("click", (e) => { e.stopPropagation(); $("menu").hidden ? openMenu() : closeMenu(); });
$("menu").addEventListener("click", (e) => e.stopPropagation());
addEventListener("click", () => { if (!$("menu").hidden) closeMenu(); });
addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("menu").hidden) closeMenu(); });
$("newsheet").addEventListener("click", (e) => { if (e.target === $("newsheet")) closeNew(); });
$("mic").addEventListener("click", openVoice);
$("vend").addEventListener("click", () => closeVoice());
$("vmute").addEventListener("click", () => {
  V.muted = !V.muted;
  if (V.mic) for (const t of V.mic.getAudioTracks()) t.enabled = !V.muted;
  vsend({ type: V.muted ? "session.input_audio.mute" : "session.input_audio.unmute", event_id: "mute_" + (++V.n) });
  $("vmute").className = V.muted ? "muted" : "";
});

tick(); live();
