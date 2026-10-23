// The orbit view: the whole fleet as a lit, solid scene, on three.js (vendor/three.module.min.js, served at /three.js).
//
// At the centre, a monument to the five-hour limit: Claude's starburst in coral, extruded and standing, ringed by two
// solid gauges on the floor (the five hours thick, the week thin). Round it, every session is a system of its own on a
// pedestal: its own starburst (in its state's colour, its rays the bars of its recent activity, so it breathes as it
// works), its context as a ring, its activity as a 3D bar chart round the rim (the newest brightest), its tasks as a
// tower of blocks (done in sage, under way lit, to do dark), each workflow a prism with its phases as beads and its
// agents wired to it, and the main thread and the other agents wired to the core. Inside a system its parts push each
// other apart and spring back to what they belong to; the pedestals grow to hold them and push each other apart, those
// waiting on you drawn in to the centre, the finished drifting out. Tool calls run along arcs into the monument as
// pellets: you watch who is eating the five hours. Hover anything to see what it is; click a session to open it; drag
// to turn, scroll or pinch to come closer. Motion is springs, never jumps; less of it for those who ask.
import * as THREE from "/three.js";

// Claude's palette: warm charcoal and ivory, coral and clay; honey for waiting, rust for stalled, sage for at work.
const P = { bg: "#1a1816", floor: "#24211e", ink: "#3a3631", ivory: "#f0eee6", oat: "#e3dacc", coral: "#d97757", clay: "#cc785c", kraft: "#d4a27f", sage: "#86b38d", honey: "#e8b04b", rust: "#e0614f", sky: "#7aa7d8", lilac: "#a99ce0", stone: "#8a867d" };
const STATE_COLOUR = { needs: P.honey, stalled: P.rust, working: P.sage, justDone: P.sage, yourTurn: P.sky, idle: P.stone, finished: P.stone };
const PULL = { needs: 1, stalled: 0.7, working: 0.55, justDone: 0.4, yourTurn: 0.35, idle: 0.14, finished: 0.1 }; // how hard each is drawn to the centre
const AGENT_COLOUR = { active: P.sage, tool: P.ivory, quiet: P.stone, done: "#5b5852", stalled: P.rust };
const RAYS = 12, BARS = 24, MONUMENT = 5.2; // rays a burst, bars round a rim, the room the monument keeps
const MAX = { rays: 12 * 64, bars: 24 * 64, tiles: 20 * 64, agents: 600, beads: 400, prisms: 160, pellets: 500, links: 1600 };
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const motion = () => (still || document.body.classList.contains("calm") ? 0.3 : 1);
const spring = (now, to, k, dt) => now + (to - now) * (1 - Math.exp(-k * dt));
let S = null;

// One ray of a starburst, Claude's way: narrow at the heart, full a third of the way out, a rounded tip; length 1 up +y.
function rayShape() {
  const sh = new THREE.Shape();
  sh.moveTo(0, 0.05); sh.quadraticCurveTo(0.12, 0.32, 0.08, 0.82); sh.quadraticCurveTo(0, 1.05, -0.08, 0.82); sh.quadraticCurveTo(-0.12, 0.32, 0, 0.05);
  return sh;
}
function instanced(geo, mat, max, { shadow = true } = {}) {
  const m = new THREE.InstancedMesh(geo, mat, max);
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  m.count = 0; m.frustumCulled = false; m.castShadow = shadow; m.receiveShadow = true;
  S.scene.add(m);
  return m;
}
const solid = (extra = {}) => new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.04, ...extra });
// A flat ring on the floor (or at a height): `frac` of it, solid: the gauges, the context rings, a waiting halo.
function arc(radius, tube, frac, colour, y = 0) {
  const geo = new THREE.TorusGeometry(radius, tube, 10, 120, Math.max(0.0001, frac) * Math.PI * 2);
  const m = new THREE.Mesh(geo, solid({ color: colour }));
  m.rotation.x = -Math.PI / 2; m.rotation.z = Math.PI / 2; m.position.y = y; m.castShadow = true;
  return m;
}

export function mount(box, hooks) {
  if (S) unmount();
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch {
    throw new Error("this browser has no WebGL");
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.35;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(P.bg);
  box.append(renderer.domElement);
  const labels = document.createElement("div"); labels.className = "olabels"; box.append(labels);
  const core = document.createElement("div"); core.className = "ocore"; labels.append(core);
  const tip = document.createElement("div"); tip.className = "otip"; tip.hidden = true; box.append(tip);
  const help = document.createElement("div"); help.className = "ohelp"; help.textContent = "drag to turn · scroll to come closer · hover for detail · click a session to open it"; box.append(help);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(P.bg, 60, 160);
  const camera = new THREE.PerspectiveCamera(40, box.clientWidth && box.clientHeight ? box.clientWidth / box.clientHeight : 1, 0.1, 600); // its shape from the start: the first state is laid out for it
  S = { box, hooks, renderer, scene, camera, labels, core, tip, sessions: new Map(), t: 0, last: performance.now(), raf: 0, maxAct: 1, limit: [-1, -1], pellets: [], flare: 0,
    view: { theta: 0.7, phi: 0.92, phiTo: 0.92, r: 40, fit: 40, zoom: 1, dragging: false, idleSince: 0, tilted: false, framed: false }, extent: 12, layoutAt: 0, portrait: camera.aspect < 0.8 };

  // Light: a warm key from high up that casts soft shadows, a sky and ground fill, a cool rim from behind.
  scene.add(new THREE.HemisphereLight(P.ivory, "#3a342d", 1.6));
  const key = new THREE.DirectionalLight("#fff1e0", 3.2);
  key.position.set(18, 34, 12); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 5; key.shadow.bias = -0.0004;
  scene.add(key); scene.add(key.target); S.key = key;
  const rim = new THREE.DirectionalLight(P.sky, 0.8); rim.position.set(-20, 12, -24); scene.add(rim);
  // The floor: warm, matte, taking the shadows; a fine dot grid on it, fading with the fog.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: P.floor, roughness: 1, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const dots = []; for (let x = -60; x <= 60; x += 2) for (let z = -60; z <= 60; z += 2) dots.push(x, 0.01, z);
  const dg = new THREE.BufferGeometry(); dg.setAttribute("position", new THREE.Float32BufferAttribute(dots, 3));
  scene.add(new THREE.Points(dg, new THREE.PointsMaterial({ color: "#3a3631", size: 0.09, sizeAttenuation: true })));

  // Shared shapes.
  const rayGeo = new THREE.ExtrudeGeometry(rayShape(), { depth: 0.14, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 2, curveSegments: 12 });
  rayGeo.translate(0, 0, -0.07);
  const unitBox = new THREE.BoxGeometry(1, 1, 1); unitBox.translate(0, 0.5, 0); // grows up from its base
  const ball = new THREE.SphereGeometry(1, 24, 16);
  const prism = new THREE.CylinderGeometry(1, 1, 1, 6); prism.translate(0, 0.5, 0);
  const disc = new THREE.CylinderGeometry(1, 1, 1, 72); disc.translate(0, 0.5, 0);
  const rimGeo = new THREE.TorusGeometry(1, 0.025, 8, 120); rimGeo.rotateX(Math.PI / 2);
  S.geos = [rayGeo, unitBox, ball, prism, disc, rimGeo];
  S.rays = instanced(rayGeo, solid({ roughness: 0.42 }), MAX.rays);
  S.bars = instanced(unitBox, solid({ roughness: 0.5 }), MAX.bars);
  S.tiles = instanced(unitBox, solid({ roughness: 0.6 }), MAX.tiles);
  S.agents = instanced(ball, solid({ roughness: 0.35 }), MAX.agents);
  S.beads = instanced(ball, solid({ roughness: 0.4 }), MAX.beads, { shadow: false });
  S.prisms = instanced(prism, solid({ roughness: 0.5 }), MAX.prisms);
  S.pedestals = instanced(disc, solid({ roughness: 0.8 }), 64);
  S.rims = instanced(rimGeo, solid({ roughness: 0.35 }), 64, { shadow: false });
  S.pelletMesh = instanced(ball, new THREE.MeshStandardMaterial({ roughness: 0.3, emissive: P.coral, emissiveIntensity: 0.6 }), MAX.pellets, { shadow: false });
  // The wiring: a line from each part to what it belongs to.
  S.linkPos = new Float32Array(MAX.links * 6); S.linkCol = new Float32Array(MAX.links * 6);
  const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.BufferAttribute(S.linkPos, 3)); lg.setAttribute("color", new THREE.BufferAttribute(S.linkCol, 3));
  S.links = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 })); S.links.frustumCulled = false; scene.add(S.links);

  // The monument: a coral starburst on a plinth, the gauges on the floor round it.
  S.mono = new THREE.Group(); scene.add(S.mono);
  const plinth = new THREE.Mesh(disc, solid({ color: P.ink, roughness: 0.85 })); plinth.scale.set(2.6, 0.35, 2.6); plinth.castShadow = plinth.receiveShadow = true; S.mono.add(plinth);
  S.monoRays = [];
  S.coralMat = solid({ color: P.coral, roughness: 0.38, emissive: P.coral, emissiveIntensity: 0.08 });
  S.monoSpark = new THREE.Group(); S.monoSpark.position.y = 2.9; S.mono.add(S.monoSpark);
  for (let i = 0; i < RAYS; i++) { const m = new THREE.Mesh(rayGeo, S.coralMat); m.rotation.z = (i / RAYS) * Math.PI * 2; m.castShadow = true; m.scale.set(1.8, 2.1, 1.8); S.monoSpark.add(m); S.monoRays.push(m); }
  S.mono.add(arc(3.7, 0.16, 1, P.ink, 0.17), arc(4.35, 0.07, 1, P.ink, 0.08));

  // Turning, coming closer, hovering, clicking.
  const el = renderer.domElement, pointers = new Map(), ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let downAt = null, pinch = 0;
  el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); downAt = [e.clientX, e.clientY, performance.now()]; S.view.dragging = true; tip.hidden = true; });
  el.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return hover(e);
    const [x0, y0] = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) S.view.zoom = Math.max(0.35, Math.min(2.2, S.view.zoom * (pinch / d))); pinch = d; return; }
    S.view.theta -= (e.clientX - x0) * 0.006;
    S.view.phi = S.view.phiTo = Math.max(0.3, Math.min(1.35, S.view.phi - (e.clientY - y0) * 0.005)); S.view.tilted = true;
  });
  const up = (e) => {
    pointers.delete(e.pointerId); pinch = 0;
    if (!pointers.size) { S.view.dragging = false; S.view.idleSince = performance.now(); }
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 6 && performance.now() - downAt[2] < 400) { const h = pick(e); if (h && h.sid) S.hooks.open(h.sid); }
    downAt = null;
  };
  el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  el.addEventListener("pointerleave", () => { tip.hidden = true; });
  el.addEventListener("wheel", (e) => { e.preventDefault(); S.view.zoom = Math.max(0.35, Math.min(2.2, S.view.zoom * Math.exp(e.deltaY * 0.001))); S.view.idleSince = performance.now(); }, { passive: false });
  // What is under the pointer: each instanced kind keeps, per instance, what it stands for.
  function pick(e) {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const kinds = [S.agents, S.tiles, S.prisms, S.rays, S.bars, S.pedestals];
    for (const k of kinds) k.computeBoundingSphere();
    const hit = ray.intersectObjects(kinds, false)[0];
    return hit && hit.object.userData.of ? hit.object.userData.of[hit.instanceId] : null;
  }
  function hover(e) {
    const h = pick(e);
    if (!h) { tip.hidden = true; el.style.cursor = ""; return; }
    tip.replaceChildren();
    const b = document.createElement("b"); b.textContent = h.title; tip.append(b);
    for (const line of h.lines || []) { const d = document.createElement("div"); d.textContent = line; tip.append(d); }
    const r = box.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(r.width - tip.offsetWidth - 8, e.clientX - r.left + 14)) + "px";
    tip.style.top = Math.max(8, Math.min(r.height - tip.offsetHeight - 8, e.clientY - r.top + 14)) + "px";
    el.style.cursor = h.sid ? "pointer" : "default";
  }
  S.ro = new ResizeObserver(() => { const w = box.clientWidth, h = box.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); refit(); });
  S.ro.observe(box);
  S.raf = requestAnimationFrame(frame);
}

// Back far enough to hold every system, inside the width and the height; looking down more steeply on a tall screen.
function refit() {
  const { camera, view } = S;
  const halfV = THREE.MathUtils.degToRad(camera.fov / 2), halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  S.portrait = camera.aspect < 0.8;
  if (!view.tilted) view.phiTo = S.portrait ? 0.55 : camera.aspect < 1.2 ? 0.75 : 0.92;
  // What has to fit: the scene's half-width across the screen, and its depth seen at the camera's tilt (with the
  // height of what stands on it), each against its own half-angle.
  const across = S.across || S.extent, deep = S.deep || S.extent, phi = view.phiTo;
  view.fit = Math.max(14, Math.max((across + 1) / Math.tan(halfH), (deep * Math.cos(phi) + 4.5 * Math.sin(phi) + 1) / Math.tan(halfV)) * 1.04);
  // In its first two seconds (the canvas's real shape and the first state arrive in either order) it snaps to the
  // framing; after that, it eases.
  if ((!view.framed || S.t < 2) && S.box.clientWidth) { view.r = view.fit * view.zoom; view.phi = view.phiTo; view.framed = true; }
  // The key light's shadows cover the scene, and no more, so they stay sharp.
  const e = S.extent + 6, sc = S.key.shadow.camera;
  sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = 1; sc.far = 120; sc.updateProjectionMatrix();
}

export function unmount() {
  if (!S) return;
  cancelAnimationFrame(S.raf); S.ro.disconnect();
  S.scene.traverse((o) => { if (o.geometry && !S.geos.includes(o.geometry)) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
  for (const g of S.geos) g.dispose();
  S.renderer.dispose(); S.renderer.forceContextLoss(); S.box.replaceChildren();
  S = null;
}

// ── the state, as systems ──
// Each session's parts, by a key that stays the same from one state to the next, so a part keeps its place.
function partsOf(s) {
  const parts = [], R = s.roster || { workflows: [], agents: [] };
  const agent = (a, parent, wf) => ({ key: "ag:" + (wf || "") + ":" + a.label, kind: "agent", parent, r: 0.3, a, title: a.label, lines: [a.tool ? a.tool + (a.doing ? " · " + a.doing : "") : a.doing, (a.model ? a.model + " · " : "") + a.ago].filter(Boolean) });
  if (R.main) parts.push(agent(R.main, "core"));
  for (const w of R.workflows) {
    const key = "wf:" + w.name;
    parts.push({ key, kind: "wf", parent: "core", r: 0.62, w, title: "≡ " + w.name, lines: [(w.phases || []).map((p) => (p.state === "done" ? "✓ " : p.state === "now" ? "◐ " : "○ ") + p.name).join("  "), w.done + "/" + w.total + " agents done · " + w.age + (w.tokens ? " · " + w.tokens + " tokens" : "")].filter(Boolean) });
    for (const a of w.agents) parts.push(agent(a, key, w.name));
  }
  for (const a of R.agents) parts.push(agent(a, "core"));
  if (s.tasks && s.tasks.total) parts.push({ key: "tasks", kind: "tasks", parent: "core", r: 0.55, t: s.tasks, title: "☰ Tasks · " + s.tasks.done + "/" + s.tasks.total + " done", lines: s.tasks.open.slice(0, 8).map((t) => (t.status === "in_progress" ? "◐ " : "○ ") + t.text + (t.blocked ? " (blocked)" : "")) });
  return parts;
}

export function update(d) {
  if (!S) return;
  const list = d.sessions || [], seen = new Set();
  let max = 1, fresh = false;
  for (const s of list) if (s.timeline) for (const v of s.timeline.tools.slice(-BARS)) max = Math.max(max, v);
  S.maxAct = max;
  for (const s of list) {
    seen.add(s.sid);
    let x = S.sessions.get(s.sid);
    if (!x) {
      // A newcomer starts out on the edge, small, and grows into its place.
      const a = S.sessions.size * 2.4 + Math.random() * 0.3, d0 = MONUMENT + 4 + Math.sqrt(S.sessions.size) * 3;
      x = { sid: s.sid, pos: new THREE.Vector2(Math.cos(a) * d0, Math.sin(a) * d0), vel: new THREE.Vector2(), R: 0.2, Rto: 2.4, grow: 0, spin: Math.random() * 6, lift: 0, parts: new Map(), act: new Array(BARS).fill(0), rayLen: new Array(RAYS).fill(0.3), tools: -1, ctxKey: null, label: document.createElement("div"), seed: [...s.sid].reduce((a2, c) => a2 + c.charCodeAt(0), 0) };
      x.label.className = "ol"; x.label.addEventListener("click", () => S.hooks.open(s.sid)); S.labels.append(x.label);
      x.group = new THREE.Group(); S.scene.add(x.group);
      S.sessions.set(s.sid, x); fresh = true;
    }
    x.s = s;
    x.colour = new THREE.Color(STATE_COLOUR[s.state] || P.stone);
    const t = s.timeline;
    if (t) {
      x.act = t.tools.slice(-BARS).map((v) => v / max);
      while (x.act.length < BARS) x.act.unshift(0);
      const now = t.tools.slice(-3).reduce((a2, b) => a2 + b, 0);
      if (x.tools >= 0 && now > x.tools) for (let k = 0; k < Math.min(6, now - x.tools); k++) S.pellets.push({ x, p: -k * 0.08, dur: 2 + Math.random() });
      x.tools = now;
    }
    // Its parts: kept where they were, new ones beside what they belong to.
    const parts = partsOf(s), keep = new Map();
    for (const p of parts) {
      const was = x.parts.get(p.key);
      const parent = p.parent === "core" ? null : keep.get(p.parent) || x.parts.get(p.parent);
      const near = parent ? parent.p : new THREE.Vector2();
      Object.assign(p, was ? { p: was.p, v: was.v, scale: was.scale } : { p: near.clone().add(new THREE.Vector2(Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.4)), v: new THREE.Vector2(), scale: 0 });
      keep.set(p.key, p);
    }
    x.parts = keep;
    // Its context as a ring round its burst, split as the cards split it.
    const ctxKey = s.ctx ? s.ctx.pct + ":" + s.ctx.split.map((p) => p.color + p.tokens).join() : "";
    if (ctxKey !== x.ctxKey) {
      if (x.ctx) { x.group.remove(x.ctx); x.ctx.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
      x.ctx = new THREE.Group();
      x.ctx.add(arc(1.85, 0.05, 1, P.ink));
      if (s.ctx) {
        const split = s.ctx.split.length ? s.ctx.split : [{ tokens: 1, color: P.ivory }], total = split.reduce((n, p) => n + p.tokens, 0) || 1;
        let from = 0;
        for (const p of split) { const frac = (p.tokens / total) * (s.ctx.pct / 100), m = arc(1.85, 0.07, frac, p.color); m.rotation.z = Math.PI / 2 - from * Math.PI * 2; from += frac; x.ctx.add(m); }
      }
      x.group.add(x.ctx); x.ctxKey = ctxKey;
    }
    // A waiting session's halo, beating.
    if (!x.halo) { x.halo = arc(1, 0.05, 1, P.honey); x.halo.material.emissive = new THREE.Color(P.honey); x.group.add(x.halo); }
    // Its label: name, state, and what it is doing, or its question.
    const text = (s.sub && s.sub.text) || "", lk = s.name + "|" + s.word + "|" + (s.time || "") + "|" + text;
    if (lk !== x.lk) {
      x.label.replaceChildren();
      const b = document.createElement("b"); b.textContent = s.name;
      const sm = document.createElement("small"); sm.textContent = (s.glyph ? s.glyph + " " : "") + s.word + (s.time ? " · " + s.time : "");
      const i2 = document.createElement("i"); i2.textContent = text;
      x.label.append(b, sm, i2); x.label.className = "ol" + (s.state === "needs" ? " needs" : "");
      x.label.style.setProperty("--c", STATE_COLOUR[s.state] || P.stone); x.lk = lk;
    }
  }
  // Newcomers: let everything settle before it is seen, so the scene opens arranged, not flying into place.
  if (fresh) { for (let k = 0; k < 360; k++) physics(1 / 60); for (const x of S.sessions.values()) { x.R = x.Rto; for (const p of x.parts.values()) p.v.set(0, 0); x.vel.set(0, 0); } S.extent = 0; S.across = 0; S.deep = 0; physics(1 / 60); if (!S.settled) { S.view.r = S.view.fit; S.settled = true; } }
  for (const [sid, x] of S.sessions) if (!seen.has(sid)) { S.scene.remove(x.group); x.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); x.label.remove(); S.sessions.delete(sid); }
  // The monument's gauges: the five hours (thick) and the week (thin), rebuilt when they move.
  const lim = (re) => (d.account && d.account.limits ? d.account.limits.find((l) => re.test(l.label)) : undefined);
  const five = lim(/5/), week = lim(/7|week/i), pct = [five ? five.pct : -1, week ? week.pct : -1];
  if (pct[0] !== S.limit[0] || pct[1] !== S.limit[1]) {
    for (const g of S.gauges || []) { S.mono.remove(g); g.geometry.dispose(); g.material.dispose(); }
    const tone = (v) => (v >= 80 ? P.rust : v >= 60 ? P.ivory : P.coral);
    S.gauges = [];
    if (pct[0] >= 0) S.gauges.push(arc(3.7, 0.2, pct[0] / 100, tone(pct[0]), 0.22));
    if (pct[1] >= 0) S.gauges.push(arc(4.35, 0.09, pct[1] / 100, P.kraft, 0.1));
    for (const g of S.gauges) S.mono.add(g);
    S.limit = pct;
  }
  S.core.replaceChildren();
  const cb = document.createElement("b"); cb.textContent = pct[0] >= 0 ? "5 HOURS · " + pct[0] + "%" + (pct[1] >= 0 ? "   WEEK · " + pct[1] + "%" : "") : "5 HOURS";
  const cs = document.createElement("span"); cs.textContent = (d.five && d.five.text) || "";
  S.core.append(cb, cs);
}

// ── physics ──
// Inside a system: each part springs to what it belongs to and pushes every other part away, so none touch. Between
// systems: each is drawn to the centre (those waiting on you hardest), kept off the monument, and pushed off its
// neighbours, its size the room its parts take.
const ORIGIN = new THREE.Vector2();
function physics(dt) {
  for (const x of S.sessions.values()) {
    const parts = [...x.parts.values()];
    for (const p of parts) {
      const parent = p.parent === "core" ? null : x.parts.get(p.parent);
      const at = parent ? parent.p : ORIGIN;
      const rest = p.parent === "core" ? (p.kind === "wf" ? 3 : p.kind === "tasks" ? 2.6 : 2.4) : 1.2;
      const dx = p.p.x - at.x, dz = p.p.y - at.y, d = Math.hypot(dx, dz) || 0.001;
      const f = (rest - d) * 8;
      p.v.x += (dx / d) * f * dt; p.v.y += (dz / d) * f * dt;
      const dc = p.p.length() || 0.001, minC = 1.9 + p.r; // off the core
      if (dc < minC) { p.v.x += (p.p.x / dc) * (minC - dc) * 30 * dt; p.v.y += (p.p.y / dc) * (minC - dc) * 30 * dt; }
    }
    for (let i = 0; i < parts.length; i++)
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i], b = parts[j], dx = b.p.x - a.p.x, dz = b.p.y - a.p.y, d = Math.hypot(dx, dz) || 0.001, min = a.r + b.r + 0.22;
        const push = d < min ? (min - d) * 40 : 0.6 / (d * d);
        a.v.x -= (dx / d) * push * dt; a.v.y -= (dz / d) * push * dt; b.v.x += (dx / d) * push * dt; b.v.y += (dz / d) * push * dt;
      }
    let reach = 1.9;
    for (const p of parts) { p.v.multiplyScalar(Math.exp(-6 * dt)); p.p.addScaledVector(p.v, dt); reach = Math.max(reach, p.p.length() + p.r + 0.5); }
    x.Rto = Math.max(2.4, reach + 0.25);
  }
  const xs = [...S.sessions.values()];
  // On a tall screen the systems are drawn in harder across it than into it, so they spread into its height: along the
  // camera's own axes, so the oval always stands up the screen.
  const th = S.view.theta, rx = -Math.sin(th), rz = Math.cos(th), squash = S.portrait ? Math.min(2.4, 1 / Math.max(0.3, S.camera.aspect)) : 1;
  for (const x of xs) {
    const d = x.pos.length() || 0.001, pull = PULL[x.s.state] ?? 0.2, k = (-pull * 1.6 * dt) / Math.max(1, d * 0.15);
    const a = x.pos.x * rx + x.pos.y * rz, b = x.pos.x * rz - x.pos.y * rx; // across the screen, and into it
    x.vel.x += k * (a * squash * rx + (b / squash) * rz); x.vel.y += k * (a * squash * rz - (b / squash) * rx);
    const minM = MONUMENT + x.R + 0.8;
    if (d < minM) x.vel.addScaledVector(x.pos, ((minM - d) * 12 * dt) / d);
  }
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++) {
      const a = xs[i], b = xs[j], dx = b.pos.x - a.pos.x, dz = b.pos.y - a.pos.y, d = Math.hypot(dx, dz) || 0.001, min = a.R + b.R + 1.8;
      const push = d < min ? (min - d) * 14 : 1.5 / (d * d);
      a.vel.x -= (dx / d) * push * dt; a.vel.y -= (dz / d) * push * dt; b.vel.x += (dx / d) * push * dt; b.vel.y += (dz / d) * push * dt;
    }
  let extent = MONUMENT + 3, across = MONUMENT + 1, deep = MONUMENT + 1;
  for (const x of xs) {
    x.vel.multiplyScalar(Math.exp(-3.2 * dt)); x.pos.addScaledVector(x.vel, dt);
    extent = Math.max(extent, x.pos.length() + x.R + 1);
    across = Math.max(across, Math.abs(x.pos.x * rx + x.pos.y * rz) + x.R);
    deep = Math.max(deep, Math.abs(x.pos.x * rz - x.pos.y * rx) + x.R);
  }
  if (Math.abs(extent - S.extent) > 1.2 || Math.abs(across - (S.across || 0)) > 1 || Math.abs(deep - (S.deep || 0)) > 1) { S.extent = extent; S.across = across; S.deep = deep; refit(); }
}

// ── each frame ──
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(), E = new THREE.Euler(0, 0, 0, "YZX"), C = new THREE.Color(), C2 = new THREE.Color();
const put = (mesh, i, x, y, z, sx, sy, sz, ry = 0, rz = 0) => { E.set(0, ry, rz, "YZX"); Q.setFromEuler(E); M.compose(V.set(x, y, z), Q, SC.set(sx, sy, sz)); mesh.setMatrixAt(i, M); };
const STONE = new THREE.Color(P.stone), IVORY = new THREE.Color(P.ivory), INK = new THREE.Color(P.ink), LILAC = new THREE.Color(P.lilac), SAGE = new THREE.Color(P.sage), CORAL = new THREE.Color(P.coral);
function frame(nowMs) {
  if (!S) return;
  S.raf = requestAnimationFrame(frame);
  const raw = Math.min(0.05, (nowMs - S.last) / 1000), dt = raw * motion(); S.last = nowMs; S.t += dt;
  const { camera, view } = S, t = S.t;
  for (let k = 0; k < 2; k++) physics(raw / 2);
  if (!view.dragging && !S.portrait && nowMs - view.idleSince > 4000) view.theta += dt * 0.04;
  view.r = spring(view.r, view.fit * view.zoom, 4, raw); view.phi = spring(view.phi, view.phiTo, 3, raw);
  camera.position.set(view.r * Math.sin(view.phi) * Math.cos(view.theta), view.r * Math.cos(view.phi), view.r * Math.sin(view.phi) * Math.sin(view.theta));
  camera.lookAt(0, 1, 0);

  // The monument breathes with the fleet's work, and warms as tool calls land in it.
  let fleet = 0; for (const x of S.sessions.values()) fleet += x.act.reduce((a, b) => a + b, 0) / BARS;
  S.monoSpark.rotation.y = Math.atan2(camera.position.x, camera.position.z) + Math.sin(t * 0.3) * 0.35;
  S.monoRays.forEach((m, i) => { const len = 2.0 + 0.4 * Math.min(1, fleet / 2) + 0.1 * Math.sin(t * 1.4 + i); m.scale.y = spring(m.scale.y, len, 3, raw); });
  S.flare = Math.max(0, S.flare - raw * 0.8);
  S.coralMat.emissiveIntensity = 0.08 + S.flare * 0.5;

  let nr = 0, nb = 0, nt = 0, na = 0, nbd = 0, np = 0, nl = 0, ns = 0;
  const of = { rays: [], bars: [], tiles: [], agents: [], prisms: [], pedestals: [] };
  const link = (ax, ay, az, bx, by, bz, col) => { if (nl >= MAX.links) return; S.linkPos.set([ax, ay, az, bx, by, bz], nl * 6); S.linkCol.set([col.r, col.g, col.b, col.r, col.g, col.b], nl * 6); nl++; };
  for (const x of S.sessions.values()) {
    const s = x.s, needs = s.state === "needs", stalled = s.state === "stalled", receded = s.state === "idle" || s.state === "finished" || s.state === "yourTurn";
    const info = { sid: s.sid, title: s.name, lines: [(s.glyph ? s.glyph + " " : "") + s.word + (s.time ? " · " + s.time : ""), (s.sub && s.sub.text) || "", s.ctx ? "context " + s.ctx.pct + "% of " + s.ctx.max : ""].filter(Boolean) };
    x.grow = spring(x.grow, 1, 2.5, raw);
    x.R = spring(x.R, x.Rto, 2.2, raw);
    const R = x.R * x.grow, px = x.pos.x, pz = x.pos.y;
    x.group.position.set(px, 0, pz);
    // The pedestal, its rim in the state's colour; a waiting session's halo beating round it.
    if (ns < 64) {
      put(S.pedestals, ns, px, 0, pz, R, 0.22, R); S.pedestals.setColorAt(ns, C.copy(INK).lerp(x.colour, 0.03)); of.pedestals[ns] = info;
      put(S.rims, ns, px, 0.23, pz, R, 2.2, R); S.rims.setColorAt(ns, C.copy(x.colour).multiplyScalar(receded ? 0.55 : 1));
      ns++;
    }
    const beat = needs ? Math.max(0, Math.sin(t * 4.2)) ** 6 : 0;
    x.halo.visible = needs; x.halo.scale.setScalar(R + 0.35 + beat * 0.4); x.halo.position.y = 0.1; x.halo.material.emissiveIntensity = 0.3 + beat;
    // The burst: standing over its pedestal, turning; lifted while it waits; each ray a bar of recent activity.
    x.lift = spring(x.lift, needs ? 0.7 : 0, 3, raw);
    const cy = 2.5 + x.lift + 0.12 * Math.sin(t * 0.9 + x.seed);
    // It faces you, turning a little either way (more while it works), so it reads as Claude's spark, not a bundle.
    x.spin = Math.atan2(camera.position.x - px, camera.position.z - pz) + Math.sin(t * (s.state === "working" ? 0.9 : 0.4) + x.seed) * 0.45;
    const wob = stalled ? Math.sin(t * 9 + x.seed) * 0.05 : 0;
    for (let i = 0; i < RAYS && nr < MAX.rays; i++) {
      const a = x.act[BARS - RAYS + i] || 0;
      const to = receded ? 0.35 : 0.55 + 0.75 * Math.sqrt(a) + (needs ? 0.25 + beat * 0.25 : 0);
      x.rayLen[i] = spring(x.rayLen[i], to * (0.9 + 0.12 * Math.sin(t * 2 + i * 1.7)), 5, raw);
      put(S.rays, nr, px, cy, pz, 1.3 * x.grow, 1.35 * x.rayLen[i] * x.grow, 1.3 * x.grow, x.spin, (i / RAYS) * Math.PI * 2 + wob);
      S.rays.setColorAt(nr, C.copy(x.colour).multiplyScalar(receded ? 0.6 : 1)); of.rays[nr] = info; nr++;
    }
    x.ctx.position.set(0, cy, 0); x.ctx.rotation.y = t * 0.15; x.ctx.scale.setScalar(x.grow);
    // The activity, as a ring of 3D bars round the rim: oldest to newest, the newest brightest.
    for (let i = 0; i < BARS && nb < MAX.bars; i++) {
      const a = x.act[i] || 0, ang = (i / BARS) * Math.PI * 1.7 + Math.PI * 0.65, h = 0.06 + 1.3 * Math.sqrt(a) * x.grow;
      put(S.bars, nb, px + Math.cos(ang) * (R - 0.32), 0.22, pz + Math.sin(ang) * (R - 0.32), 0.17, h, 0.17, -ang);
      S.bars.setColorAt(nb, C.copy(x.colour).lerp(IVORY, (i / BARS) * 0.35).multiplyScalar(0.55 + 0.45 * (i / BARS)));
      of.bars[nb] = { sid: s.sid, title: s.name + " · activity", lines: ["tool calls across the window, a bar each, round the rim to the newest"] }; nb++;
    }
    // Its parts.
    for (const p of x.parts.values()) {
      p.scale = spring(p.scale, 1, 3, raw);
      const wx = px + p.p.x, wz = pz + p.p.y, sc = p.scale * x.grow;
      const parent = p.parent === "core" ? null : x.parts.get(p.parent);
      if (p.kind === "wf" && np < MAX.prisms) {
        const live = p.w.outcome === "running";
        put(S.prisms, np, wx, 0.22, wz, 0.62 * sc, 0.42 * sc, 0.62 * sc, t * 0.2);
        S.prisms.setColorAt(np, C.copy(LILAC).multiplyScalar(live ? 1 : 0.55)); of.prisms[np] = { title: p.title, lines: p.lines }; np++;
        // Its phases: beads in an arc over it, done in lilac, the one under way lit and beating, the rest dark.
        const ph = (p.w.phases || []).slice(0, 10);
        ph.forEach((q, k) => {
          if (nbd >= MAX.beads) return;
          const ang = (k / Math.max(1, ph.length - 1) - 0.5) * 2.2;
          const lit = q.state === "now" ? 0.14 + 0.05 * Math.sin(t * 6) : 0.11;
          put(S.beads, nbd, wx + Math.sin(ang) * 0.75 * sc, 0.95 + Math.cos(ang) * 0.35, wz, lit * sc, lit * sc, lit * sc);
          S.beads.setColorAt(nbd, C.set(q.state === "done" ? P.lilac : q.state === "now" ? P.ivory : "#4a4458")); nbd++;
        });
        link(px, cy - 0.6, pz, wx, 0.64 * sc + 0.22, wz, C2.copy(LILAC).multiplyScalar(0.7));
      } else if (p.kind === "agent" && na < MAX.agents) {
        const st = p.a.state, r = (st === "done" ? 0.2 : 0.3) * sc;
        const bob = st === "active" ? Math.abs(Math.sin(t * 3 + p.key.length)) * 0.18 : 0, ay = 0.22 + r + 0.15 + bob;
        put(S.agents, na, wx, ay, wz, r, r, r);
        S.agents.setColorAt(na, C.set(AGENT_COLOUR[st] || P.stone)); of.agents[na] = { title: (st === "active" ? "● " : st === "tool" ? "◐ " : st === "done" ? "✓ " : "○ ") + p.title, lines: p.lines }; na++;
        if (parent) link(px + parent.p.x, 0.5, pz + parent.p.y, wx, ay, wz, C2.set(AGENT_COLOUR[st] || P.stone).multiplyScalar(0.6));
        else link(px, cy - 0.6, pz, wx, ay, wz, C2.set(AGENT_COLOUR[st] || P.stone).multiplyScalar(0.6));
      } else if (p.kind === "tasks") {
        // A tower of blocks, a task each (twenty at most): done in sage, under way lit and beating, to do dark.
        const T = p.t, n = Math.min(20, T.total), doing = T.open.filter((q) => q.status === "in_progress").length;
        const dn = Math.round((T.done / T.total) * n), dg = Math.min(n - dn, Math.ceil((doing / T.total) * n));
        for (let k = 0; k < n && nt < MAX.tiles; k++) {
          put(S.tiles, nt, wx, 0.22 + k * 0.16 * sc, wz, 0.62 * sc, 0.13 * sc, 0.62 * sc, 0.4);
          S.tiles.setColorAt(nt, k < dn ? SAGE : k < dn + dg ? C2.copy(IVORY).multiplyScalar(0.75 + 0.25 * Math.sin(t * 5)) : C2.copy(INK).lerp(STONE, 0.18)); of.tiles[nt] = { title: p.title, lines: p.lines }; nt++;
        }
        link(px, cy - 0.6, pz, wx, 0.22 + n * 0.16 * sc, wz, C2.copy(SAGE).multiplyScalar(0.6));
      }
    }
    // Pellets, now and then, as often as it is busy, between those each new state brings.
    const busy = x.act.reduce((a, b) => a + b, 0) / BARS;
    if (!receded && Math.random() < busy * raw * 1.6) S.pellets.push({ x, p: 0, dur: 2 + Math.random() });
  }
  // Tool calls running into the monument along arcs: it warms as each lands.
  S.pellets = S.pellets.filter((q) => {
    q.p += raw / q.dur;
    if (q.p >= 1) { S.flare = Math.min(1, S.flare + 0.04); return false; }
    return q.p < 0 || S.sessions.has(q.x.sid);
  }).slice(-MAX.pellets);
  let npl = 0;
  for (const q of S.pellets) {
    if (q.p < 0) continue;
    const a = q.x.pos, e = Math.sin(Math.PI * q.p), u = 1 - q.p;
    put(S.pelletMesh, npl, a.x * u, (2.1 + q.x.lift) * u + 3.4 * q.p + e * (2 + q.x.R * 0.4), a.y * u, 0.11, 0.11, 0.11);
    S.pelletMesh.setColorAt(npl, C.copy(q.x.colour).lerp(CORAL, q.p)); npl++;
  }
  const done = (mesh, n, ofs) => { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; if (ofs) mesh.userData.of = ofs; };
  done(S.rays, nr, of.rays); done(S.bars, nb, of.bars); done(S.tiles, nt, of.tiles); done(S.agents, na, of.agents); done(S.beads, nbd); done(S.prisms, np, of.prisms); done(S.pedestals, ns, of.pedestals); done(S.rims, ns); done(S.pelletMesh, npl);
  S.links.geometry.setDrawRange(0, nl * 2); S.links.geometry.attributes.position.needsUpdate = true; S.links.geometry.attributes.color.needsUpdate = true;

  S.renderer.render(S.scene, camera);
  labelsFrame(nowMs);
}

// ── labels ──
// Over each burst: placed one by one, those waiting on you first, then the busiest, then the nearest; one that would
// land on another moves clear or is cut to its name, or left out unless it waits on you. Kept on the screen.
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
function labelsFrame(nowMs) {
  const { camera, box } = S, w = box.clientWidth, h = box.clientHeight, relayout = nowMs - S.layoutAt > 250;
  if (relayout) S.layoutAt = nowMs;
  const busy = (x) => x.act.reduce((a, b) => a + b, 0);
  const order = [...S.sessions.values()].map((x) => {
    tmp.set(x.pos.x, 4.3 + x.lift, x.pos.y);
    const dist = tmp2.copy(tmp).sub(camera.position).length();
    tmp.project(camera);
    return { x, dist, on: tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2, sx: (tmp.x * 0.5 + 0.5) * w, sy: (-tmp.y * 0.5 + 0.5) * h };
  }).sort((a, b) => (b.x.s.state === "needs") - (a.x.s.state === "needs") || busy(b.x) - busy(a.x) || a.dist - b.dist);
  const toward = Math.atan2(camera.position.x, camera.position.z);
  tmp.set(Math.sin(toward) * 4.9, 0.2, Math.cos(toward) * 4.9).project(camera);
  const cx = (tmp.x * 0.5 + 0.5) * w, cy = (-tmp.y * 0.5 + 0.5) * h;
  S.core.style.left = cx.toFixed(1) + "px"; S.core.style.top = (cy + 8).toFixed(1) + "px";
  const placed = [{ x: cx, y: cy + 8, w: 280, h: 34 }];
  let full = 0;
  for (const o of order) {
    const L = o.x.label, needs = o.x.s.state === "needs";
    L.style.display = o.on ? "" : "none";
    if (!o.on) continue;
    if (relayout || !o.x.lw) { L.classList.remove("far"); o.x.lw = L.offsetWidth; o.x.lh = L.offsetHeight; o.x.short = !needs; o.x.gone = false; if (!o.x.short && !needs) full++; }
    let lw = o.x.lw, lh = o.x.short ? 30 : o.x.lh, y = o.sy - lh - 10;
    const sx = Math.max(Math.min(lw, w) / 2 + 6, Math.min(w - Math.min(lw, w) / 2 - 6, o.sx));
    const hits = (yy) => placed.some((p) => Math.abs(p.x - sx) < (p.w + lw) / 2 + 6 && yy < p.y + p.h + 4 && yy + lh > p.y - 4);
    if (relayout) {
      let ok = !hits(y);
      for (const dy of needs ? [-(lh + 6), -(2 * lh + 12), lh + 40, -(3 * lh + 18)] : [-(lh + 6), lh + 40]) if (!ok && !hits(y + dy)) { y += dy; ok = true; }
      if (!ok && !needs && !o.x.short) { o.x.short = true; lh = 30; lw = Math.min(lw, 180); y = o.sy - lh - 10; ok = !hits(y); for (const dy of [-(lh + 6), lh + 40]) if (!ok && !hits(y + dy)) { y += dy; ok = true; } }
      o.x.gone = !ok && !needs;
      o.x.dy = y - (o.sy - lh - 10);
    } else y += o.x.dy || 0;
    if (o.x.gone) { L.style.display = "none"; continue; }
    L.classList.toggle("far", o.x.short);
    placed.push({ x: sx, y, w: lw, h: lh });
    L.style.transform = "translate(" + sx.toFixed(1) + "px," + y.toFixed(1) + "px) translate(-50%,0)";
    L.style.zIndex = String(1000 - Math.round(o.dist * 10));
  }
}
