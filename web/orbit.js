// The orbit view: the whole fleet in motion, in 3D, on three.js (vendor/three.module.min.js, served at /three.js).
//
// At the centre, the five-hour limit: a coral starburst, Claude's own, with the share used as an arc around it. Round it,
// on rings, every session as a starburst of its own in its state's colour, its rays the bars of its recent activity, so
// it breathes as it works: those waiting on you on the inner ring, beating amber; working and stalled ones (red, and
// shaking) next; your turn, idle and finished further out, their rays drawn in. Each has its context as a ring round
// it, its agents as moons (quick while they write), its workflows' phases as a necklace of beads, and its tool calls
// as comets that fall into the limit at the centre: you watch who is eating the five hours. A task finished throws
// green sparks. Its name, state and what it is doing (its question, when it waits) float beside it; a click opens it.
// Drag to turn, scroll or pinch to come closer. It moves less for those who ask for less motion.
import * as THREE from "/three.js";

const RINGS = [5.4, 9.2, 13, 16.6]; // the orbits, inner to outer
const RING_OF = { needs: 0, stalled: 1, working: 1, justDone: 2, yourTurn: 2, idle: 3, finished: 3 };
const RING_SPEED = [0.16, 0.1, 0.065, 0.04]; // radians a second: the inner rings go round faster
const RAYS = 12; // a ray a bar of the most recent activity, as the burst's rays
const CORAL = "#d97757";
const AMBER = "#e5b544";
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
// Less motion for those who ask for it: the system's setting, or the page's own (Options → Calm motion).
const motion = () => (still || document.body.classList.contains("calm") ? 0.25 : 1);
let S = null; // everything while the view is up

// A soft round glow, white, for sprites and particles to tint.
function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.18, "rgba(255,255,255,.75)"); r.addColorStop(0.45, "rgba(255,255,255,.18)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// One ray of a burst, Claude's way: narrow at the heart, full a third of the way out, a rounded tip. Length 1, along +y.
function rayGeometry() {
  const sh = new THREE.Shape();
  sh.moveTo(0, 0.06); sh.quadraticCurveTo(0.11, 0.32, 0.075, 0.82); sh.quadraticCurveTo(0, 1.04, -0.075, 0.82); sh.quadraticCurveTo(-0.11, 0.32, 0, 0.06);
  return new THREE.ShapeGeometry(sh, 10);
}
const add = (c) => new THREE.SpriteMaterial({ map: S.glow, color: c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
const ease = (now, to, rate, dt) => now + (to - now) * (1 - Math.exp(-rate * dt));

// A starburst: rays round a bright heart, in one colour, turned to face the camera each frame.
function makeBurst(colour, size, jitterSeed) {
  const g = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const rays = [];
  let seed = jitterSeed;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < RAYS; i++) {
    const m = new THREE.Mesh(S.ray, mat);
    m.rotation.z = (i / RAYS) * Math.PI * 2 + (rnd() - 0.5) * 0.12;
    m.userData = { len: 0.5, shape: 0.82 + rnd() * 0.36, phase: rnd() * Math.PI * 2 };
    m.scale.set(size, size * 0.5, 1);
    g.add(m); rays.push(m);
  }
  const heart = new THREE.Sprite(add(colour)); heart.scale.setScalar(size * 1.6); g.add(heart);
  return { g, rays, mat, heart, size };
}
// An arc in the burst's plane: `frac` of a ring, for the context round a session and the share used round the core.
function arcMesh(r, width, frac, colour, opacity = 1) {
  const geo = new THREE.RingGeometry(r, r + width, 96, 1, Math.PI / 2, -Math.max(0.0001, frac) * Math.PI * 2);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
}

export function mount(box, hooks) {
  if (S) unmount();
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (e) {
    throw new Error("this browser has no WebGL");
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  box.append(renderer.domElement);
  const labels = document.createElement("div"); labels.className = "olabels"; box.append(labels);
  const core = document.createElement("div"); core.className = "ocore"; labels.append(core);
  const help = document.createElement("div"); help.className = "ohelp"; help.textContent = "drag to turn · scroll to come closer · click a session to open it"; box.append(help);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05070c, 0.011);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 500);
  S = { box, hooks, renderer, scene, camera, labels, core, sessions: new Map(), t: 0, last: performance.now(), raf: 0, glow: glowTexture(), ray: rayGeometry(),
    view: { theta: 0.6, phi: 1.0, phiTo: 1.0, r: 29, fit: 29, zoom: 1, dragging: false, idleSince: 0, tilted: false }, wave: null, waveAt: -10, layoutAt: 0, flare: 0, maxAct: 1, five: null, limit: -1, comets: [], sparks: [], small: innerWidth < 600 };

  // The stars: a still field far out, that turns a little with the view.
  const starN = S.small ? 900 : 1800, sp = new Float32Array(starN * 3);
  for (let i = 0; i < starN; i++) { const r = 90 + Math.random() * 90, u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, q = Math.sqrt(1 - u * u); sp.set([r * q * Math.cos(a), r * u, r * q * Math.sin(a)], i * 3); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  S.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x8fa3c7, size: 0.7, sizeAttenuation: true, transparent: true, opacity: 0.75, depthWrite: false }));
  scene.add(S.stars);

  // Nebulae, far off: colour and depth behind it all, shifting as the view turns.
  for (const [c, x, y, z, sc, o] of [[CORAL, -70, 18, -90, 150, 0.07], ["#2f6bff", 90, -10, -60, 170, 0.08], ["#8a5cff", 10, 40, 110, 140, 0.06], ["#56cdd6", -100, -30, 70, 120, 0.04]]) {
    const n = new THREE.Sprite(add(c)); n.material.opacity = o; n.position.set(x, y, z); n.scale.setScalar(sc); scene.add(n);
  }
  // The shockwave: when the core is fed hard, a ring runs out across the orbits.
  S.wave = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 128), new THREE.MeshBasicMaterial({ color: CORAL, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  S.wave.rotation.x = -Math.PI / 2; scene.add(S.wave);
  // The orbits, faint.
  for (const r of RINGS) {
    const pts = []; for (let i = 0; i <= 160; i++) { const a = (i / 160) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x22304a, transparent: true, opacity: 0.55 })));
  }

  // The core: the five-hour limit, a coral burst, with the share used as an arc round it.
  S.coreGroup = new THREE.Group(); scene.add(S.coreGroup);
  S.coreBurst = makeBurst(CORAL, 2.2, 7);
  S.coreGroup.add(S.coreBurst.g);
  S.coreHalo = new THREE.Sprite(add(CORAL)); S.coreHalo.scale.setScalar(13); S.coreHalo.material.opacity = 0.35; S.coreGroup.add(S.coreHalo);
  S.coreTrack = arcMesh(3.1, 0.09, 1, 0x2a313b, 0.9); S.coreBurst.g.add(S.coreTrack);

  // Comets (tool calls falling into the core) and sparks (a task finished): a pool of glowing points each.
  const pool = (n, size) => {
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("color", new THREE.BufferAttribute(col, 3)); geo.setDrawRange(0, 0);
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size, map: S.glow, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    scene.add(pts); return { pts, pos, col, n };
  };
  S.cometPool = pool(S.small ? 900 : 1800, 0.8);
  S.sparkPool = pool(600, 0.35);

  // Turning and coming closer: drag, wheel, two fingers. Left alone for a few seconds, it turns by itself.
  const el = renderer.domElement, pointers = new Map();
  let downAt = null, pinch = 0;
  el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); downAt = [e.clientX, e.clientY, performance.now()]; S.view.dragging = true; });
  el.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const [x0, y0] = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) S.view.zoom = Math.max(0.4, Math.min(2.2, S.view.zoom * (pinch / d)));
      pinch = d; return;
    }
    S.view.theta -= (e.clientX - x0) * 0.006; S.view.phi = S.view.phiTo = Math.max(0.25, Math.min(1.45, S.view.phi - (e.clientY - y0) * 0.005)); S.view.tilted = true;
  });
  const up = (e) => {
    pointers.delete(e.pointerId); pinch = 0;
    if (!pointers.size) { S.view.dragging = false; S.view.idleSince = performance.now(); }
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 6 && performance.now() - downAt[2] < 400) pick(e);
    downAt = null;
  };
  el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  el.addEventListener("wheel", (e) => { e.preventDefault(); S.view.zoom = Math.max(0.4, Math.min(2.2, S.view.zoom * Math.exp(e.deltaY * 0.001))); S.view.idleSince = performance.now(); }, { passive: false });
  const ray = new THREE.Raycaster();
  function pick(e) {
    const r = el.getBoundingClientRect(), v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v, camera);
    const hits = ray.intersectObjects([...S.sessions.values()].map((x) => x.hit));
    if (hits.length) S.hooks.open(hits[0].object.userData.sid);
  }
  // Framed to the screen's shape: far enough back that the outer orbit fits across it, and on a tall screen looking
  // down more steeply, so the rings use its height. Zooming is a factor on that.
  S.reach = RINGS[1] + 3;
  S.ro = new ResizeObserver(() => {
    const w = box.clientWidth, h = box.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); S.small = w < 600;
    refit();
  });
  S.ro.observe(box);
  S.raf = requestAnimationFrame(frame);
}

// Back far enough that the outermost orbit in use fits across the screen; on a tall screen, looking down more steeply.
function refit() {
  const { camera, view } = S;
  // The orbits in use, as a sphere, inside both the width and the height: nothing in front of the core falls off the
  // bottom, and on a narrow screen the labels at the sides stay on it.
  const halfV = THREE.MathUtils.degToRad(camera.fov / 2), halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  view.fit = Math.max(18, (S.reach / Math.sin(Math.min(halfV, halfH))) * (camera.aspect < 0.8 ? 1.12 : 1.02));
  if (!view.tilted) view.phiTo = camera.aspect < 0.8 ? 0.55 : camera.aspect < 1.2 ? 0.8 : 1.0;
  if (!view.framed && S.box.clientWidth) { view.r = view.fit; view.phi = view.phiTo; view.framed = true; } // the first view starts framed, not sweeping in
}
export function unmount() {
  if (!S) return;
  cancelAnimationFrame(S.raf);
  S.ro.disconnect();
  S.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
  S.glow.dispose(); S.ray.dispose();
  S.renderer.dispose(); S.renderer.forceContextLoss();
  S.box.replaceChildren();
  S = null;
}

// A session's place and look, made the first time it is seen.
function makeSession(s) {
  const x = { sid: s.sid, angle: Math.random() * Math.PI * 2, ring: 1, radius: RINGS[1] + 4, colour: new THREE.Color(s.color), group: new THREE.Group(), moons: [], beads: [], label: document.createElement("div"),
    act: new Array(RAYS).fill(0), tools: -1, done: -1, beat: Math.random(), ctxPct: -1, state: "", seed: 1 + [...s.sid].reduce((a, c) => a + c.charCodeAt(0), 0) };
  x.burst = makeBurst(s.color, 1.05, x.seed);
  x.group.add(x.burst.g);
  x.halo = new THREE.Sprite(add(s.color)); x.halo.scale.setScalar(4.2); x.halo.material.opacity = 0.28; x.group.add(x.halo);
  // A ripple, for a session waiting on you: a ring that grows and fades, again and again.
  x.ripple = new THREE.Mesh(new THREE.RingGeometry(1, 1.07, 64), new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  x.burst.g.add(x.ripple);
  x.hit = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 8), new THREE.MeshBasicMaterial({ visible: false })); x.hit.userData.sid = s.sid; x.group.add(x.hit);
  // A tether of light to the core, as bright as the session is busy: what feeds on the five hours, and how hard.
  x.tether = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: s.color, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending }));
  S.scene.add(x.tether);
  x.moonGroup = new THREE.Group(); x.moonGroup.rotation.set(0.9, 0, 0.35); x.group.add(x.moonGroup);
  x.beadGroup = new THREE.Group(); x.beadGroup.rotation.set(-0.5, 0, -0.6); x.group.add(x.beadGroup);
  S.scene.add(x.group);
  x.label.className = "ol"; x.label.dataset.sid = s.sid;
  x.label.addEventListener("click", () => S.hooks.open(s.sid));
  S.labels.append(x.label);
  return x;
}
function dropSession(x) {
  x.group.traverse((o) => { if (o.geometry && o.geometry !== S.ray) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  S.scene.remove(x.group); x.label.remove();
  S.scene.remove(x.tether); x.tether.geometry.dispose(); x.tether.material.dispose();
}

// A new state from fleet: what each session is and is doing, what the five hours are at. Nothing is rebuilt that has
// not changed; what has eases to its new look in the frames that follow.
export function update(d) {
  if (!S) return;
  const list = d.sessions || [], seen = new Set();
  // The rays: the most recent bars of each session's tool calls, on one scale for the whole fleet.
  let max = 1;
  for (const s of list) if (s.timeline) for (const v of s.timeline.tools.slice(-RAYS)) max = Math.max(max, v);
  S.maxAct = max;
  const perRing = [[], [], [], []];
  for (const s of list) {
    seen.add(s.sid);
    let x = S.sessions.get(s.sid);
    if (!x) S.sessions.set(s.sid, (x = makeSession(s)));
    x.s = s;
    x.ring = RING_OF[s.state] ?? 3;
    perRing[x.ring].push(x);
    if (x.state !== s.state) { x.colour.set(s.color); x.burst.mat.color.set(s.color); x.burst.heart.material.color.set(s.color); x.halo.material.color.set(s.color); x.tether.material.color.set(s.color); x.state = s.state; }
    const t = s.timeline;
    if (t) {
      const recent = t.tools.slice(-RAYS);
      x.act = recent.map((v) => v / max);
      // New tool calls since the last state: comets, falling into the core.
      const now = t.tools.slice(-3).reduce((a, b) => a + b, 0);
      if (x.tools >= 0 && now > x.tools) for (let i = 0; i < Math.min(8, now - x.tools); i++) S.comets.push({ x, p: -i * 0.07, dur: 1.7 + Math.random() * 1.1, bend: (Math.random() - 0.5) * 6, lift: 1 + Math.random() * 3 });
      x.tools = now;
    }
    // A task finished since the last state: green sparks.
    const done = s.tasks ? s.tasks.done : 0;
    if (x.done >= 0 && done > x.done) burst(x, "#50c878", 46);
    x.done = done;
    // Its context, as a ring round it, split as the cards split it.
    const pct = s.ctx ? s.ctx.pct : 0;
    if (pct !== x.ctxPct) {
      if (x.ctx) { x.burst.g.remove(x.ctx); x.ctx.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
      x.ctx = new THREE.Group();
      x.ctx.add(arcMesh(1.32, 0.06, 1, 0x2a313b, 0.8));
      const split = s.ctx && s.ctx.split.length ? s.ctx.split : s.ctx ? [{ tokens: 1, color: pct >= 80 ? "#f0625c" : pct >= 60 ? "#f5f7fa" : "#56cdd6" }] : [];
      const total = split.reduce((n, p) => n + p.tokens, 0) || 1;
      let from = 0;
      for (const p of split) {
        const frac = (p.tokens / total) * (pct / 100);
        const m = arcMesh(1.32, 0.06, frac, p.color);
        m.rotation.z = -from * Math.PI * 2; from += frac;
        x.ctx.add(m);
      }
      x.burst.g.add(x.ctx); x.ctxPct = pct;
    }
    // Its agents as moons: one a thread busy in the window, quick while it writes, slow while it waits on a tool.
    const agents = (s.agents || []).slice(0, 10);
    while (x.moons.length < agents.length) { const m = new THREE.Sprite(add("#56cdd6")); m.scale.setScalar(0.55); x.moonGroup.add(m); x.moons.push({ m, a: Math.random() * Math.PI * 2, r: 1.9 + x.moons.length * 0.17 }); }
    while (x.moons.length > agents.length) { const m = x.moons.pop(); x.moonGroup.remove(m.m); m.m.material.dispose(); }
    agents.forEach((a, i) => { const mo = x.moons[i]; mo.speed = a.state === "active" ? 2.6 : a.state === "tool" ? 1.1 : 0.35; mo.m.material.color.set(a.state === "tool" ? "#f5f7fa" : a.state === "active" ? "#56cdd6" : "#3d6f78"); });
    // Its workflows' phases as beads on a necklace: done bright, the one under way white and beating, the rest dim.
    const phases = ((s.roster && s.roster.workflows) || []).filter((w) => w.outcome === "running").flatMap((w) => w.phases).slice(0, 14);
    const key = phases.map((p) => p.name + ":" + p.state).join("|");
    if (key !== x.beadKey) {
      for (const b of x.beads) { x.beadGroup.remove(b); b.material.dispose(); }
      x.beads = phases.map((p, i) => { const b = new THREE.Sprite(add(p.state === "done" ? "#be94ff" : p.state === "now" ? "#ffffff" : "#4a3d66")); b.scale.setScalar(p.state === "now" ? 0.75 : 0.5); b.userData = { now: p.state === "now", a: (i / Math.max(1, phases.length)) * Math.PI * 2 }; x.beadGroup.add(b); return b; });
      x.beadKey = key;
    }
    // Its label: name, state, and what it is doing, or its question when it waits.
    const text = (s.sub && s.sub.text) || "";
    const html = s.name + "|" + s.word + "|" + (s.time || "") + "|" + text;
    if (html !== x.labelKey) {
      x.label.replaceChildren();
      const b = document.createElement("b"); b.textContent = s.name;
      const sm = document.createElement("small"); sm.textContent = (s.glyph ? s.glyph + " " : "") + s.word + (s.time ? " · " + s.time : "");
      const i = document.createElement("i"); i.textContent = text;
      x.label.append(b, sm, i);
      x.label.className = "ol" + (s.state === "needs" ? " needs" : "");
      x.label.style.setProperty("--c", s.color);
      x.labelKey = html;
    }
  }
  for (const [sid, x] of S.sessions) if (!seen.has(sid)) { dropSession(x); S.sessions.delete(sid); }
  const reach = Math.max(RINGS[1], ...[...S.sessions.values()].map((x) => RINGS[x.ring])) + 3;
  if (reach !== S.reach) { S.reach = reach; refit(); }
  // Each ring's sessions spread evenly round it, in a steady order, so a newcomer slides the others along.
  perRing.forEach((xs, ring) => xs.sort((a, b) => (a.sid < b.sid ? -1 : 1)).forEach((x, i) => { x.slot = (i / xs.length) * Math.PI * 2 + ring * 0.7; }));
  // The core: the five-hour share used, as an arc, and its forecast in words.
  const five = d.account && d.account.limits ? d.account.limits.find((l) => /5/.test(l.label)) : undefined;
  const pct = five ? five.pct : -1;
  if (pct !== S.limit) {
    if (S.coreArc) { S.coreBurst.g.remove(S.coreArc); S.coreArc.geometry.dispose(); S.coreArc.material.dispose(); S.coreArc = null; }
    if (pct >= 0) { S.coreArc = arcMesh(3.1, 0.16, pct / 100, pct >= 80 ? "#f0625c" : pct >= 60 ? "#f5f7fa" : "#56cdd6"); S.coreBurst.g.add(S.coreArc); }
    S.limit = pct;
  }
  S.core.replaceChildren();
  const cb = document.createElement("b"); cb.textContent = pct >= 0 ? "5 HOURS · " + pct + "%" : "5 HOURS";
  const cs = document.createElement("span"); cs.textContent = (d.five && d.five.text) || "";
  S.core.append(cb, cs);
}

// Sparks from a session: a task finished.
function burst(x, colour, n) {
  const c = new THREE.Color(colour), at = x.group.position.clone();
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 3.5);
    S.sparks.push({ p: at.clone(), v, life: 0, dur: 0.9 + Math.random() * 0.8, c });
  }
}

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
const busyOf = (x) => x.act.reduce((a, b) => a + b, 0);
function frame(nowMs) {
  if (!S) return;
  S.raf = requestAnimationFrame(frame);
  const dt = Math.min(0.05, (nowMs - S.last) / 1000) * motion(); S.last = nowMs; S.t += dt;
  const { camera, view } = S, t = S.t;
  // The camera: where it is turned to, easing in; left alone, it turns on slowly by itself.
  if (!view.dragging && nowMs - view.idleSince > 4000) view.theta += dt * 0.05;
  view.r = ease(view.r, view.fit * view.zoom, 5, dt / motion());
  view.phi = ease(view.phi, view.phiTo, 3, dt / motion());
  camera.position.set(view.r * Math.sin(view.phi) * Math.cos(view.theta), view.r * Math.cos(view.phi), view.r * Math.sin(view.phi) * Math.sin(view.theta));
  camera.lookAt(0, 0, 0);
  S.stars.rotation.y += dt * 0.004;

  // The core breathes with the fleet's work, and flares as comets land.
  S.flare = Math.max(0, S.flare - dt * 0.9);
  let fleetAct = 0; for (const x of S.sessions.values()) fleetAct += x.act.reduce((a, b) => a + b, 0) / RAYS;
  const coreLive = Math.min(1, fleetAct / 2.5);
  S.coreBurst.g.quaternion.copy(camera.quaternion);
  S.coreBurst.g.rotateZ(t * 0.05);
  S.coreBurst.rays.forEach((r, i) => { const u = r.userData; const len = (0.75 + 0.3 * coreLive + S.flare * 0.5) * u.shape * (1 + 0.08 * Math.sin(t * 1.3 + u.phase)); r.scale.y = ease(r.scale.y, 2.2 * len, 3, dt); });
  S.coreHalo.material.opacity = 0.28 + 0.2 * coreLive + S.flare * 0.4;
  S.coreHalo.scale.setScalar(12 + 3 * coreLive + S.flare * 5);
  S.coreBurst.heart.scale.setScalar(3.2 + S.flare * 1.4);

  // The sessions: each glides to its place on its ring and keeps going round; its rays follow its recent activity.
  for (const x of S.sessions.values()) {
    const s = x.s, ringR = RINGS[x.ring];
    x.radius = ease(x.radius, ringR, 1.4, dt / motion());
    const target = (x.slot || 0) + t * RING_SPEED[x.ring];
    let diff = ((target - x.angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    x.angle += diff * (1 - Math.exp(-1.6 * dt / motion()));
    x.group.position.set(Math.cos(x.angle) * x.radius, Math.sin(t * 0.7 + x.seed) * 0.45 + (x.ring === 0 ? 0.8 : 0), Math.sin(x.angle) * x.radius);
    const g = x.burst.g;
    g.quaternion.copy(camera.quaternion);
    g.rotateZ(t * (s.state === "working" ? 0.35 : 0.12));
    const needs = s.state === "needs", stalled = s.state === "stalled", receded = s.state === "idle" || s.state === "finished" || s.state === "yourTurn";
    // A waiting session's heart beats: a double beat, twice a second and a bit.
    const ph = (t * 1.15 + x.beat) % 1, beat = needs ? Math.exp(-ph * 14) * 0.5 + Math.exp(-Math.max(0, ph - 0.18) * 14) * (ph > 0.18 ? 0.32 : 0) : 0;
    const shake = stalled ? (Math.random() - 0.5) * 0.08 : 0;
    g.scale.setScalar(1 + beat * 0.55 + shake);
    x.burst.rays.forEach((r, i) => {
      const u = r.userData, a = x.act[(i + Math.floor(t * 0.5)) % RAYS] || 0;
      let len = receded ? 0.32 : 0.55 + 1.25 * Math.sqrt(a);
      len *= u.shape * (1 + 0.1 * Math.sin(t * 2.2 + u.phase));
      if (needs) len = Math.max(len, 0.95) * (1 + beat * 0.4);
      r.scale.y = ease(r.scale.y, 1.05 * len, 6, dt);
    });
    x.burst.mat.opacity = receded ? 0.4 : stalled ? 0.6 + Math.random() * 0.35 : 0.95;
    x.halo.material.opacity = (receded ? 0.1 : 0.26) + beat * 0.6;
    x.halo.scale.setScalar(4.2 + beat * 3);
    // The ripple: from a waiting session, rings going out.
    const rp = (t * 0.6 + x.beat) % 1;
    x.ripple.material.opacity = needs ? (1 - rp) * 0.7 : 0;
    x.ripple.scale.setScalar(1.3 + rp * 2.8);
    // Moons and beads.
    for (const mo of x.moons) { mo.a += dt * mo.speed; mo.m.position.set(Math.cos(mo.a) * mo.r, 0, Math.sin(mo.a) * mo.r); }
    x.beadGroup.rotation.y += dt * 0.25;
    for (const b of x.beads) { const u = b.userData, r = 2.7; b.position.set(Math.cos(u.a) * r, 0, Math.sin(u.a) * r); if (u.now) b.scale.setScalar(0.6 + 0.3 * (0.5 + 0.5 * Math.sin(t * 6))); }
    // Its tether: from it to the core, brighter the busier it is.
    const tp = x.tether.geometry.attributes.position; tp.setXYZ(0, x.group.position.x, x.group.position.y, x.group.position.z); tp.setXYZ(1, 0, 0, 0); tp.needsUpdate = true;
    const busyNow = x.act.reduce((a, b) => a + b, 0) / RAYS;
    x.tether.material.opacity = receded ? 0.03 : 0.06 + busyNow * 0.5 + beat * 0.3;
    // A working session throws a comet now and then, as often as it is busy, between the ones each new state brings.
    const busy = x.act.reduce((a, b) => a + b, 0) / RAYS;
    if (!receded && Math.random() < busy * dt * 2.2 * (S.small ? 0.5 : 1)) S.comets.push({ x, p: 0, dur: 1.8 + Math.random(), bend: (Math.random() - 0.5) * 6, lift: 1 + Math.random() * 3 });
  }

  // The shockwave: when the core has been fed hard, a ring runs out across the orbits and fades.
  if (S.flare > 0.55 && t - S.waveAt > 3.5) S.waveAt = t;
  const wp = (t - S.waveAt) / 2.6;
  S.wave.material.opacity = wp >= 0 && wp < 1 ? (1 - wp) * 0.55 : 0;
  S.wave.scale.setScalar(2 + Math.max(0, Math.min(1, wp)) * (RINGS[3] + 4));
  // Comets: along a curve from the session to the core, a head and a fading tail; the core flares as one lands.
  const cp = S.cometPool, tail = 7;
  let k = 0;
  S.comets = S.comets.filter((c) => {
    c.p += dt / c.dur;
    if (c.p >= 1) { S.flare = Math.min(1.2, S.flare + 0.05); return false; }
    if (c.p < 0) return true;
    if (!S.sessions.has(c.x.sid)) return false;
    const from = c.x.group.position;
    for (let j = 0; j < tail && k < cp.n; j++) {
      const p = Math.max(0, c.p - j * 0.028), q = 1 - p;
      // A quadratic curve: lifted and bent off the straight line, as if falling into the core's pull.
      const mx = from.x * 0.5 + c.bend * Math.sin(c.x.angle + 1.57), my = from.y + c.lift, mz = from.z * 0.5 + c.bend * Math.cos(c.x.angle + 1.57);
      cp.pos[k * 3] = q * q * from.x + 2 * q * p * mx;
      cp.pos[k * 3 + 1] = q * q * from.y + 2 * q * p * my;
      cp.pos[k * 3 + 2] = q * q * from.z + 2 * q * p * mz;
      const fade = (1 - j / tail) * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, c.p * 1.1)));
      cp.col[k * 3] = c.x.colour.r * fade; cp.col[k * 3 + 1] = c.x.colour.g * fade; cp.col[k * 3 + 2] = c.x.colour.b * fade;
      k++;
    }
    return true;
  });
  if (S.comets.length > 600) S.comets.splice(0, S.comets.length - 600);
  cp.pts.geometry.setDrawRange(0, k); cp.pts.geometry.attributes.position.needsUpdate = true; cp.pts.geometry.attributes.color.needsUpdate = true;

  // Sparks: out and fading.
  const spp = S.sparkPool; let n = 0;
  S.sparks = S.sparks.filter((p) => {
    p.life += dt; if (p.life >= p.dur || n >= spp.n) return false;
    p.p.addScaledVector(p.v, dt); p.v.multiplyScalar(1 - dt * 1.5);
    const f = 1 - p.life / p.dur;
    spp.pos.set([p.p.x, p.p.y, p.p.z], n * 3); spp.col.set([p.c.r * f, p.c.g * f, p.c.b * f], n * 3); n++;
    return true;
  });
  spp.pts.geometry.setDrawRange(0, n); spp.pts.geometry.attributes.position.needsUpdate = true; spp.pts.geometry.attributes.color.needsUpdate = true;

  S.renderer.render(S.scene, camera);

  // The labels, over the canvas above each session: placed one by one, those waiting on you first, then the nearest;
  // one that would land on another moves up or down clear of it, or, failing that, is cut to its name. Behind the view,
  // hidden. Measured a few times a second, moved every frame.
  const w = S.box.clientWidth, h = S.box.clientHeight, relayout = nowMs - S.layoutAt > 250;
  if (relayout) S.layoutAt = nowMs;
  const order = [...S.sessions.values()].map((x) => {
    tmp.copy(x.group.position); tmp.y += 1.9;
    const dist = tmp2.copy(tmp).sub(camera.position).length();
    tmp.project(camera);
    return { x, dist, on: tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2, sx: (tmp.x * 0.5 + 0.5) * w, sy: (-tmp.y * 0.5 + 0.5) * h };
  }).sort((a, b) => (b.x.s.state === "needs") - (a.x.s.state === "needs") || busyOf(b.x) - busyOf(a.x) || a.dist - b.dist);
  // Those waiting on you get their whole label; the five busiest theirs, where there is room; the rest a name.
  let full = 0;
  // The core's words are in the way of every label: they go in first.
  tmp.set(0, -3.6, 0).project(camera);
  const placed = [{ x: (tmp.x * 0.5 + 0.5) * w, y: (-tmp.y * 0.5 + 0.5) * h, w: 220, h: 34 }];
  for (const o of order) {
    const L = o.x.label;
    L.style.display = o.on ? "" : "none";
    if (!o.on) continue;
    const needs = o.x.s.state === "needs";
    if (relayout || !o.x.lw) { L.classList.remove("far"); o.x.lw = L.offsetWidth; o.x.lh = L.offsetHeight; o.x.short = !needs && full >= 5; o.x.gone = false; if (!o.x.short && !needs) full++; }
    let lw = o.x.lw, lh = o.x.short ? 30 : o.x.lh, y = o.sy - lh - 18;
    // Kept on the screen: a label near an edge slides in.
    const sx = Math.max(Math.min(lw, w) / 2 + 6, Math.min(w - Math.min(lw, w) / 2 - 6, o.sx));
    const hits = (yy) => placed.some((p) => Math.abs(p.x - sx) < (p.w + lw) / 2 + 6 && yy < p.y + p.h + 4 && yy + lh > p.y - 4);
    if (relayout) {
      let ok = !hits(y);
      for (const dy of needs ? [-(lh + 6), lh + 46, -(2 * lh + 12), 2 * lh + 52, -(3 * lh + 18), 3 * lh + 58] : [-(lh + 6), lh + 46, -(2 * lh + 12)]) if (!ok && !hits(y + dy)) { y += dy; ok = true; }
      if (!ok && !needs && !o.x.short) { o.x.short = true; lh = 30; lw = Math.min(lw, 180); y = o.sy - lh - 18; ok = !hits(y); for (const dy of [-(lh + 6), lh + 46]) if (!ok && !hits(y + dy)) { y += dy; ok = true; } }
      // Nowhere clear even as a name: left out, unless it waits on you.
      o.x.gone = !ok && !needs;
      o.x.dy = y - (o.sy - lh - 18);
    } else y += o.x.dy || 0;
    if (o.x.gone) { L.style.display = "none"; continue; }
    L.classList.toggle("far", o.x.short || (o.dist > view.r + 6 && o.x.s.state !== "needs"));
    placed.push({ x: sx, y, w: lw, h: lh });
    L.style.transform = "translate(" + sx.toFixed(1) + "px," + y.toFixed(1) + "px) translate(-50%,0)";
    L.style.zIndex = String(1000 - Math.round(o.dist * 10));
  }
  tmp.set(0, -3.6, 0).project(camera);
  S.core.style.top = ((-tmp.y * 0.5 + 0.5) * h).toFixed(1) + "px";
  S.core.style.left = ((tmp.x * 0.5 + 0.5) * w).toFixed(1) + "px";
}
