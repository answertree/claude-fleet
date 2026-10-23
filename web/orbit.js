// The orbit view: the whole fleet as a lit, glowing scene in Fleet's own colours, on three.js (vendor/, served at
// /three.js) with its bloom (vendor/three-addons, at /three-addons/).
//
// A navy night of stars and drifting dust. At the centre, Answertree's A, solid and bevelled, along the logo's cyan,
// blue and violet, turning slowly; under it, glowing gauges for the five hours and the week, and holographic rings
// turning round it. Round it, in a cloud through all three dimensions, every session is a system of its own on a
// floating platform, in its state's colour (amber waiting, red stalled, green at work, blue your turn): a pool of
// that light under it, a ring of light turning over it; its own starburst, its rays the bars of its recent activity, so
// it breathes as it works; its context as a ring; its activity as a 3D bar chart round the rim, graded cyan to violet by
// height; its tasks as a tower of blocks; each workflow a violet prism with its phases as beads and its agents wired
// to it, light running down the wires while they work. A session waiting on you lifts, beats, and sends a beacon of
// light up into the sky. Physics keeps it all apart, in 3D: a system's parts push each other off and spring back to
// what they belong to; the platforms grow to hold them and push each other off, above, below and beside, those
// waiting on you drawn to the centre. Tool calls fly into the A as comets with tails; it flares as they land. Hover anything to see what it is;
// click a session to open it; drag to turn, scroll or pinch to come closer. Motion is springs; less for those who ask.
import * as THREE from "/three.js";
import { EffectComposer } from "/three-addons/EffectComposer.js";
import { RenderPass } from "/three-addons/RenderPass.js";
import { UnrealBloomPass } from "/three-addons/UnrealBloomPass.js";
import { OutputPass } from "/three-addons/OutputPass.js";

// Fleet's colours: the page's navy and panels, its state colours, and the logo's gradient (cyan, blue, violet).
const P = { bg: "#070a10", floor: "#0a0f17", panel: "#151b23", line: "#262d37", text: "#c6cdd7", white: "#f5f7fa", dim: "#6b7380", cyan: "#56cdd6", blue: "#61aaff", violet: "#be94ff", green: "#50c878", amber: "#e5b544", red: "#f0625c", done: "#3e805c", g1: "#25d8fc", g2: "#0075fc", g3: "#6c28fa" };
const STATE_COLOUR = { needs: P.amber, stalled: P.red, working: P.green, justDone: P.green, yourTurn: P.blue, idle: P.dim, finished: P.done };
const PULL = { needs: 1, stalled: 0.7, working: 0.55, justDone: 0.4, yourTurn: 0.35, idle: 0.14, finished: 0.1 }; // how hard each is drawn to the centre
const AGENT_COLOUR = { active: P.cyan, tool: P.white, quiet: "#3d6f78", done: "#2b4a52", stalled: P.red };
// The logo's gradient, at f from 0 to 1: cyan, blue, violet.
const GRAD = [new THREE.Color(P.g1), new THREE.Color(P.g2), new THREE.Color(P.g3)];
const brand = (f, out = new THREE.Color()) => (f < 0.5 ? out.copy(GRAD[0]).lerp(GRAD[1], f * 2) : out.copy(GRAD[1]).lerp(GRAD[2], (f - 0.5) * 2));
const RAYS = 12, BARS = 24, MONUMENT = 6.6; // rays a burst, bars round a rim, the room the monument keeps
// Answertree's A, from the logo (packages/ui-leaves answertree-logo.svelte, viewBox 24 x 20): a tall leaning bar and
// the foot beside it. Its path is made only of M, H, L, C and Z, read here into shapes, y up, centred.
const LOGO_PATH = "M9.10254 0.586914H15.1533L12.0068 8.31738L11.9883 8.27148L11.4463 9.61621L7.99316 18.1709C7.80568 18.6353 7.35557 18.9395 6.85645 18.9395H0.869141L7.96582 1.35449C8.15326 0.890228 8.60299 0.58696 9.10254 0.586914ZM18.3066 10.3164C19.107 10.3164 19.8283 10.8024 20.1299 11.5459L23.1289 18.9395H17.6406C16.8402 18.9395 16.1189 18.4531 15.8174 17.71L12.8174 10.3164H18.3066Z";
export function logoShapes(d = LOGO_PATH, scale = 0.42) {
  const shapes = [], tok = d.match(/[MHLCZ]|-?\d*\.?\d+/g) || [];
  let sh = null, cmd = "", i = 0, x = 0, y = 0;
  const X = (v) => (v - 12) * scale, Y = (v) => -(v - 9.76) * scale; // centred, y up
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    if (/[MHLCZ]/.test(tok[i])) cmd = tok[i++];
    if (cmd === "M") { x = num(); y = num(); sh = new THREE.Shape(); sh.moveTo(X(x), Y(y)); shapes.push(sh); cmd = "L"; }
    else if (cmd === "L") { x = num(); y = num(); sh.lineTo(X(x), Y(y)); }
    else if (cmd === "H") { x = num(); sh.lineTo(X(x), Y(y)); }
    else if (cmd === "C") { const a = num(), b = num(), c = num(), e = num(); x = num(); y = num(); sh.bezierCurveTo(X(a), Y(b), X(c), Y(e), X(x), Y(y)); }
    else if (cmd === "Z") { sh.closePath(); cmd = ""; }
    else i++;
  }
  return shapes;
}
const MAX = { rays: 12 * 64, bars: 24 * 64, tiles: 20 * 64, agents: 600, beads: 400, prisms: 160, pellets: 300, trail: 5, links: 1600, flow: 1200, hud: 14 * 64, dust: 700 };
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
const solid = (extra = {}) => new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.15, ...extra });
// A material that glows in each instance's own colour (a material's emissive is one colour for all; this adds the
// instance's), by `amount`: what the bloom then lifts into light.
function glowing(mat, amount) {
  mat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n#if defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR )\ntotalEmissiveRadiance += vColor.rgb * " + amount.toFixed(3) + ";\n#endif"); };
  mat.customProgramCacheKey = () => "glow" + amount;
  return mat;
}
// A soft round light, white, for pools of light and dust to tint; and a vertical fade, for the beacons.
function radialTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.35, "rgba(255,255,255,.45)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
function fadeTexture() {
  const c = document.createElement("canvas"); c.width = 4; c.height = 256;
  const g = c.getContext("2d"), r = g.createLinearGradient(0, 0, 0, 256);
  r.addColorStop(0, "rgba(255,255,255,0)"); r.addColorStop(0.7, "rgba(255,255,255,.35)"); r.addColorStop(1, "rgba(255,255,255,1)");
  g.fillStyle = r; g.fillRect(0, 0, 4, 256);
  return new THREE.CanvasTexture(c);
}
// The sky: Fleet's splash, a navy glow fading to black.
function skyTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 512;
  const g = c.getContext("2d"), r = g.createRadialGradient(256, 200, 0, 256, 256, 420);
  r.addColorStop(0, "#1a2540"); r.addColorStop(0.45, "#0e1526"); r.addColorStop(1, "#05070c");
  g.fillStyle = r; g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// A flat ring on the floor (or at a height): `frac` of it, solid: the gauges, the context rings, a waiting halo.
function arc(radius, tube, frac, colour, y = 0, glow = 0) {
  const geo = new THREE.TorusGeometry(radius, tube, 10, 120, Math.max(0.0001, frac) * Math.PI * 2);
  const m = new THREE.Mesh(geo, solid({ color: colour, emissive: glow ? colour : "#000000", emissiveIntensity: glow }));
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
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = false; // a cloud in space: nothing for shadows to fall on
  renderer.setClearColor(P.bg);
  box.append(renderer.domElement);
  const labels = document.createElement("div"); labels.className = "olabels"; box.append(labels);
  const core = document.createElement("div"); core.className = "ocore"; labels.append(core);
  const tip = document.createElement("div"); tip.className = "otip"; tip.hidden = true; box.append(tip);
  const help = document.createElement("div"); help.className = "ohelp"; help.textContent = "drag to turn · scroll to come closer · hover for detail · click a session to open it"; box.append(help);
  const scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog("#0a0f1a", 70, 180);
  const camera = new THREE.PerspectiveCamera(40, box.clientWidth && box.clientHeight ? box.clientWidth / box.clientHeight : 1, 0.1, 600); // its shape from the start: the first state is laid out for it
  S = { box, hooks, renderer, scene, camera, labels, core, tip, sessions: new Map(), t: 0, last: performance.now(), raf: 0, maxAct: 1, limit: [-1, -1], pellets: [], flare: 0,
    view: { theta: 0.7, phi: 1.12, phiTo: 1.12, r: 40, fit: 40, zoom: 1, dragging: false, idleSince: 0, tilted: false, framed: false }, extent: 12, layoutAt: 0, portrait: camera.aspect < 0.8, beacons: new Map() };
  // Bloom: what glows, glows; the shapes stay solid.
  S.composer = new EffectComposer(renderer);
  S.composer.addPass(new RenderPass(scene, camera));
  S.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.45, 0.62);
  S.composer.addPass(S.bloom);
  S.composer.addPass(new OutputPass());

  // Light: a cool key from high up that casts soft shadows, a navy fill, a violet rim from behind, and the monument's
  // own cyan light on everything near it.
  scene.add(new THREE.HemisphereLight("#9fc7ff", "#0b111a", 0.75));
  const key = new THREE.DirectionalLight("#e3ecff", 2.4);
  key.position.set(18, 34, 12); key.castShadow = false; key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 5; key.shadow.bias = -0.0004;
  scene.add(key); scene.add(key.target); S.key = key;
  const rim = new THREE.DirectionalLight(P.g3, 0.6); rim.position.set(-20, 12, -24); scene.add(rim);
  S.monoLight = new THREE.PointLight(P.g1, 14, 22, 2); S.monoLight.position.set(0, 0, 0); scene.add(S.monoLight);
  // Stars, far off all round.
  const stars = [];
  for (let k = 0; k < 1600; k++) { const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, q = Math.sqrt(1 - u * u), r = 120 + Math.random() * 120; stars.push(r * q * Math.cos(a), r * u, r * q * Math.sin(a)); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.Float32BufferAttribute(stars, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: "#8fa3c7", size: 0.6, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false })));
  // Dust: motes in the logo's colours, drifting up and round.
  const dn = MAX.dust, dp = new Float32Array(dn * 3), dc = new Float32Array(dn * 3), dtmp = new THREE.Color();
  for (let i = 0; i < dn; i++) { const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 36; dp.set([Math.cos(a) * r, (Math.random() - 0.5) * 30, Math.sin(a) * r], i * 3); brand(Math.random(), dtmp); dc.set([dtmp.r, dtmp.g, dtmp.b], i * 3); }
  const dgeo = new THREE.BufferGeometry(); dgeo.setAttribute("position", new THREE.BufferAttribute(dp, 3)); dgeo.setAttribute("color", new THREE.BufferAttribute(dc, 3));
  S.dust = new THREE.Points(dgeo, new THREE.PointsMaterial({ size: 0.16, map: radialTexture(), vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(S.dust);

  // Shared shapes.
  const rayGeo = new THREE.ExtrudeGeometry(rayShape(), { depth: 0.14, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 2, curveSegments: 12 });
  rayGeo.translate(0, 0, -0.07);
  const unitBox = new THREE.BoxGeometry(1, 1, 1); unitBox.translate(0, 0.5, 0); // grows up from its base
  const ball = new THREE.SphereGeometry(1, 24, 16);
  const prism = new THREE.CylinderGeometry(1, 1, 1, 6); prism.translate(0, 0.5, 0);
  const disc = new THREE.CylinderGeometry(1, 1, 1, 72); disc.translate(0, 0.5, 0);
  const rimGeo = new THREE.TorusGeometry(1, 0.025, 8, 120); rimGeo.rotateX(Math.PI / 2);
  const pool = new THREE.PlaneGeometry(1, 1); pool.rotateX(-Math.PI / 2);
  const seg = new THREE.TorusGeometry(1, 0.022, 6, 16, 0.32); seg.rotateX(Math.PI / 2); // a segment of a turning ring of light
  const dash = new THREE.TorusGeometry(1, 0.0045, 6, 12, 0.14); dash.rotateX(Math.PI / 2); // a fine dash, for the monument's rings
  S.geos = [rayGeo, unitBox, ball, prism, disc, rimGeo, pool, seg, dash];
  S.rays = instanced(rayGeo, glowing(solid({ roughness: 0.35 }), 0.32), MAX.rays);
  S.bars = instanced(unitBox, glowing(solid({ roughness: 0.4 }), 0.28), MAX.bars);
  S.tiles = instanced(unitBox, glowing(solid({ roughness: 0.5 }), 0.22), MAX.tiles);
  S.agents = instanced(ball, glowing(solid({ roughness: 0.3 }), 0.75), MAX.agents);
  S.beads = instanced(ball, glowing(solid({ roughness: 0.4 }), 0.85), MAX.beads, { shadow: false });
  S.prisms = instanced(prism, glowing(solid({ roughness: 0.25, metalness: 0.3 }), 0.28), MAX.prisms);
  S.pedestals = instanced(disc, solid({ roughness: 0.3, metalness: 0.5 }), 64);
  S.rims = instanced(rimGeo, glowing(solid({ roughness: 0.3 }), 0.9), 64, { shadow: false });
  S.pools = instanced(pool, new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), 64, { shadow: false });
  S.pools.receiveShadow = false;
  S.hud = instanced(seg, glowing(solid({ roughness: 0.3 }), 0.7), MAX.hud, { shadow: false });
  S.flow = instanced(ball, glowing(solid({ roughness: 0.3 }), 1.1), MAX.flow, { shadow: false });
  S.pelletMesh = instanced(ball, glowing(solid({ roughness: 0.3 }), 1.1), MAX.pellets * MAX.trail, { shadow: false });
  S.beamTex = fadeTexture();
  // The wiring: a line from each part to what it belongs to.
  S.linkPos = new Float32Array(MAX.links * 6); S.linkCol = new Float32Array(MAX.links * 6);
  const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.BufferAttribute(S.linkPos, 3)); lg.setAttribute("color", new THREE.BufferAttribute(S.linkCol, 3));
  S.links = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })); S.links.frustumCulled = false; scene.add(S.links);

  // The centre: Answertree's A, extruded and bevelled, coloured across the logo's gradient, its edges lit, turning
  // slowly; under it the gauges, floating; round it two holographic rings, tilted, turning.
  S.mono = new THREE.Group(); scene.add(S.mono);
  const aGeo = new THREE.ExtrudeGeometry(logoShapes(), { depth: 1.2, bevelEnabled: true, bevelThickness: 0.18, bevelSize: 0.12, bevelSegments: 4, curveSegments: 16 });
  aGeo.center();
  aGeo.computeBoundingBox();
  { const pos = aGeo.attributes.position, bb = aGeo.boundingBox, cols = new Float32Array(pos.count * 3), c = new THREE.Color();
    for (let k = 0; k < pos.count; k++) { brand(((pos.getX(k) - bb.min.x) / (bb.max.x - bb.min.x)) * 0.7 + ((pos.getY(k) - bb.min.y) / (bb.max.y - bb.min.y)) * 0.3, c); cols.set([c.r, c.g, c.b], k * 3); }
    aGeo.setAttribute("color", new THREE.BufferAttribute(cols, 3)); }
  S.aMat = glowing(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.3, emissive: "#ffffff", emissiveIntensity: 0 }), 0.85);
  S.logo = new THREE.Group(); S.mono.add(S.logo);
  S.logo.add(new THREE.Mesh(aGeo, S.aMat));
  S.logo.add(new THREE.LineSegments(new THREE.EdgesGeometry(aGeo, 35), new THREE.LineBasicMaterial({ color: "#bdf6ff", transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })));
  S.geos.push(aGeo);
  S.gaugeY = -3.4; // the gauges float under the A
  S.mono.add(arc(3.7, 0.16, 1, P.line, S.gaugeY), arc(4.35, 0.07, 1, P.line, S.gaugeY - 0.12));
  S.holo = [];
  for (const [r, c, tilt] of [[5.6, P.g1, 0.35], [6.3, P.g3, -0.25]]) {
    const ring = new THREE.Group();
    const mat = solid({ color: c, emissive: c, emissiveIntensity: 0.9 });
    for (let k = 0; k < 30; k++) { const m = new THREE.Mesh(dash, mat); m.scale.setScalar(r); m.rotation.y = (k / 30) * Math.PI * 2; ring.add(m); }
    ring.rotation.x = tilt; ring.position.y = 0; S.mono.add(ring); S.holo.push(ring);
  }

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
  S.ro = new ResizeObserver(() => { const w = box.clientWidth, h = box.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); S.composer.setPixelRatio(renderer.getPixelRatio()); S.composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); refit(); });
  S.ro.observe(box);
  S.raf = requestAnimationFrame(frame);
}

// Back far enough to hold every system, inside the width and the height; looking down more steeply on a tall screen.
function refit() {
  const { camera, view } = S;
  const halfV = THREE.MathUtils.degToRad(camera.fov / 2), halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  S.portrait = camera.aspect < 0.8;
  if (!view.tilted) view.phiTo = S.portrait ? 1.2 : 1.12; // from a little above: the cloud's height shows
  // What has to fit: the scene's half-width across the screen, and its depth seen at the camera's tilt (with the
  // height of what stands on it), each against its own half-angle.
  const across = S.across || S.extent, deep = S.deep || S.extent, high = S.high || MONUMENT, phi = view.phiTo;
  view.fit = Math.max(14, Math.max((across + 1) / Math.tan(halfH), (deep * Math.cos(phi) + high * Math.sin(phi) + 1) / Math.tan(halfV)) * 1.0);
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
  S.composer.dispose(); S.renderer.dispose(); S.renderer.forceContextLoss(); S.box.replaceChildren();
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
      const a = S.sessions.size * 2.4 + Math.random() * 0.3, d0 = MONUMENT + 4 + Math.sqrt(S.sessions.size) * 3, h0 = (((S.sessions.size * 0.618) % 1) - 0.5) * 12;
      x = { sid: s.sid, pos: new THREE.Vector2(Math.cos(a) * d0, Math.sin(a) * d0), vel: new THREE.Vector2(), h: h0, vh: 0, R: 0.2, Rto: 2.4, grow: 0, spin: Math.random() * 6, lift: 0, parts: new Map(), act: new Array(BARS).fill(0), rayLen: new Array(RAYS).fill(0.3), tools: -1, ctxKey: null, label: document.createElement("div"), seed: [...s.sid].reduce((a2, c) => a2 + c.charCodeAt(0), 0) };
      x.label.className = "ol"; x.label.addEventListener("click", () => S.hooks.open(s.sid)); S.labels.append(x.label);
      x.group = new THREE.Group(); S.scene.add(x.group);
      S.sessions.set(s.sid, x); fresh = true;
    }
    x.s = s;
    x.colour = new THREE.Color(STATE_COLOUR[s.state] || P.dim);
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
      x.ctx.add(arc(1.85, 0.05, 1, P.line));
      if (s.ctx) {
        const split = s.ctx.split.length ? s.ctx.split : [{ tokens: 1, color: P.white }], total = split.reduce((n, p) => n + p.tokens, 0) || 1;
        let from = 0;
        for (const p of split) { const frac = (p.tokens / total) * (s.ctx.pct / 100), m = arc(1.85, 0.07, frac, p.color, 0, 0.9); m.rotation.z = Math.PI / 2 - from * Math.PI * 2; from += frac; x.ctx.add(m); }
      }
      x.group.add(x.ctx); x.ctxKey = ctxKey;
    }
    // A waiting session's halo, beating.
    if (!x.halo) { x.halo = arc(1, 0.05, 1, P.amber, 0, 1); x.group.add(x.halo); }
    // A beacon for a session waiting on you: a column of amber light up into the sky.
    if (s.state === "needs" && !S.beacons.has(s.sid)) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.7, 26, 32, 1, true), new THREE.MeshBasicMaterial({ color: P.amber, map: S.beamTex, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      b.position.y = 13; x.group.add(b); S.beacons.set(s.sid, b);
    } else if (s.state !== "needs" && S.beacons.has(s.sid)) { const b = S.beacons.get(s.sid); x.group.remove(b); b.geometry.dispose(); b.material.dispose(); S.beacons.delete(s.sid); }
    // Its label: name, state, and what it is doing, or its question.
    const text = (s.sub && s.sub.text) || "", lk = s.name + "|" + s.word + "|" + (s.time || "") + "|" + text;
    if (lk !== x.lk) {
      x.label.replaceChildren();
      const b = document.createElement("b"); b.textContent = s.name;
      const sm = document.createElement("small"); sm.textContent = (s.glyph ? s.glyph + " " : "") + s.word + (s.time ? " · " + s.time : "");
      const i2 = document.createElement("i"); i2.textContent = text;
      x.label.append(b, sm, i2); x.label.className = "ol" + (s.state === "needs" ? " needs" : "");
      x.label.style.setProperty("--c", STATE_COLOUR[s.state] || P.dim); x.lk = lk;
    }
  }
  // Newcomers: let everything settle before it is seen, so the scene opens arranged, not flying into place.
  if (fresh) { for (let k = 0; k < 360; k++) physics(1 / 60); for (const x of S.sessions.values()) { x.R = x.Rto; for (const p of x.parts.values()) p.v.set(0, 0); x.vel.set(0, 0); x.vh = 0; } S.extent = 0; S.across = 0; S.deep = 0; S.high = 0; physics(1 / 60); if (!S.settled) { S.view.r = S.view.fit; S.settled = true; } }
  for (const [sid, x] of S.sessions) if (!seen.has(sid)) { S.scene.remove(x.group); x.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); x.label.remove(); S.beacons.delete(sid); S.sessions.delete(sid); }
  // The monument's gauges: the five hours (thick) and the week (thin), rebuilt when they move.
  const lim = (re) => (d.account && d.account.limits ? d.account.limits.find((l) => re.test(l.label)) : undefined);
  const five = lim(/5/), week = lim(/7|week/i), pct = [five ? five.pct : -1, week ? week.pct : -1];
  if (pct[0] !== S.limit[0] || pct[1] !== S.limit[1]) {
    for (const g of S.gauges || []) { S.mono.remove(g); g.geometry.dispose(); g.material.dispose(); }
    const tone = (v) => (v >= 80 ? P.red : v >= 60 ? P.white : P.cyan); // as the page's rings
    S.gauges = [];
    if (pct[0] >= 0) S.gauges.push(arc(3.7, 0.2, pct[0] / 100, tone(pct[0]), S.gaugeY + 0.02, 1.1));
    if (pct[1] >= 0) S.gauges.push(arc(4.35, 0.09, pct[1] / 100, P.violet, S.gaugeY - 0.1, 1.1));
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
  // Up and down too: drawn in less steeply than across, so the cloud has height (more of it on a tall screen).
  const lift = S.portrait ? 0.16 : 0.3;
  for (const x of xs) {
    const d = Math.hypot(x.pos.x, x.pos.y, x.h) || 0.001, pull = PULL[x.s.state] ?? 0.2, k = (-pull * 1.0 * dt) / Math.max(1, d * 0.15);
    const a = x.pos.x * rx + x.pos.y * rz, b = x.pos.x * rz - x.pos.y * rx; // across the screen, and into it
    x.vel.x += k * (a * squash * rx + (b / squash) * rz); x.vel.y += k * (a * squash * rz - (b / squash) * rx);
    x.vh += k * x.h * lift;
    // Off the A, in every direction.
    const minM = MONUMENT + x.R + 0.8;
    if (d < minM) { const f = ((minM - d) * 12 * dt) / d; x.vel.addScaledVector(x.pos, f); x.vh += x.h * f; }
  }
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++) {
      // In 3D: a platform is flat, so one above another needs less room than one beside it.
      const a = xs[i], b = xs[j], dx = b.pos.x - a.pos.x, dz = b.pos.y - a.pos.y, dy = (b.h - a.h) * 1.5, d = Math.hypot(dx, dz, dy) || 0.001, min = a.R + b.R + 2.4;
      const push = d < min ? (min - d) * 14 : 5 / (d * d);
      a.vel.x -= (dx / d) * push * dt; a.vel.y -= (dz / d) * push * dt; b.vel.x += (dx / d) * push * dt; b.vel.y += (dz / d) * push * dt;
      a.vh -= (dy / d) * push * dt; b.vh += (dy / d) * push * dt;
    }
  let extent = MONUMENT + 3, across = MONUMENT + 1, deep = MONUMENT + 1, high = MONUMENT;
  for (const x of xs) {
    x.vel.multiplyScalar(Math.exp(-3.2 * dt)); x.pos.addScaledVector(x.vel, dt);
    x.vh *= Math.exp(-3.2 * dt); x.h += x.vh * dt;
    extent = Math.max(extent, Math.hypot(x.pos.x, x.pos.y, x.h) + x.R + 1);
    high = Math.max(high, Math.abs(x.h) + 4.5);
    across = Math.max(across, Math.abs(x.pos.x * rx + x.pos.y * rz) + x.R);
    deep = Math.max(deep, Math.abs(x.pos.x * rz - x.pos.y * rx) + x.R);
  }
  if (Math.abs(extent - S.extent) > 1.2 || Math.abs(across - (S.across || 0)) > 1 || Math.abs(deep - (S.deep || 0)) > 1 || Math.abs(high - (S.high || 0)) > 1) { S.extent = extent; S.across = across; S.deep = deep; S.high = high; refit(); }
}

// ── each frame ──
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(), E = new THREE.Euler(0, 0, 0, "YZX"), C = new THREE.Color(), C2 = new THREE.Color();
const put = (mesh, i, x, y, z, sx, sy, sz, ry = 0, rz = 0) => { E.set(0, ry, rz, "YZX"); Q.setFromEuler(E); M.compose(V.set(x, y, z), Q, SC.set(sx, sy, sz)); mesh.setMatrixAt(i, M); };
const DIM = new THREE.Color(P.dim), WHITE = new THREE.Color(P.white), PANEL = new THREE.Color(P.panel), VIOLET = new THREE.Color(P.violet), GREEN = new THREE.Color(P.green), CYAN = new THREE.Color(P.g1), NAVY = new THREE.Color("#1b2433");
function frame(nowMs) {
  if (!S) return;
  S.raf = requestAnimationFrame(frame);
  const raw = Math.min(0.05, (nowMs - S.last) / 1000), dt = raw * motion(); S.last = nowMs; S.t += dt;
  const { camera, view } = S, t = S.t;
  for (let k = 0; k < 2; k++) physics(raw / 2);
  if (!view.dragging && !S.portrait && nowMs - view.idleSince > 4000) view.theta += dt * 0.04;
  view.r = spring(view.r, view.fit * view.zoom, 4, raw); view.phi = spring(view.phi, view.phiTo, 3, raw);
  camera.position.set(view.r * Math.sin(view.phi) * Math.cos(view.theta), view.r * Math.cos(view.phi), view.r * Math.sin(view.phi) * Math.sin(view.theta));
  camera.lookAt(0, 0, 0);

  // The monument breathes with the fleet's work, and warms as tool calls land in it.
  let fleet = 0; for (const x of S.sessions.values()) fleet += x.act.reduce((a, b) => a + b, 0) / BARS;
  // The A turns slowly, bobs a little, and warms as tool calls land in it.
  S.logo.rotation.y = t * 0.3; S.logo.position.y = Math.sin(t * 0.6) * 0.25;
  S.flare = Math.max(0, S.flare - raw * 0.8);
  S.aMat.emissiveIntensity = S.flare * 0.35;
  S.monoLight.intensity = 12 + S.flare * 16 + 2 * Math.sin(t * 1.3);
  S.holo[0].rotation.y = t * 0.35; S.holo[1].rotation.y = -t * 0.22;
  // The dust drifts up and round, and comes back in at the floor.
  const dpos = S.dust.geometry.attributes.position;
  for (let i = 0; i < dpos.count; i++) { let y = dpos.getY(i) + dt * 0.35; if (y > 15) y = -15; dpos.setY(i, y); }
  dpos.needsUpdate = true; S.dust.rotation.y = t * 0.01;

  let nr = 0, nb = 0, nt = 0, na = 0, nbd = 0, np = 0, nl = 0, ns = 0, nh = 0, nf = 0;
  const of = { rays: [], bars: [], tiles: [], agents: [], prisms: [], pedestals: [] };
  const link = (ax, ay, az, bx, by, bz, col, live = false) => {
    if (nl >= MAX.links) return;
    S.linkPos.set([ax, ay, az, bx, by, bz], nl * 6); S.linkCol.set([col.r, col.g, col.b, col.r, col.g, col.b], nl * 6); nl++;
    // Light running down a live wire, out from the core to the agent.
    if (live) for (let k = 0; k < 3 && nf < MAX.flow; k++) { const f = (t * 0.9 + k / 3 + (ax + bz) * 0.1) % 1; put(S.flow, nf, ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f, 0.07, 0.07, 0.07); S.flow.setColorAt(nf, col); nf++; }
  };
  for (const x of S.sessions.values()) {
    const s = x.s, needs = s.state === "needs", stalled = s.state === "stalled", receded = s.state === "idle" || s.state === "finished" || s.state === "yourTurn";
    const info = { sid: s.sid, title: s.name, lines: [(s.glyph ? s.glyph + " " : "") + s.word + (s.time ? " · " + s.time : ""), (s.sub && s.sub.text) || "", s.ctx ? "context " + s.ctx.pct + "% of " + s.ctx.max : ""].filter(Boolean) };
    x.grow = spring(x.grow, 1, 2.5, raw);
    x.R = spring(x.R, x.Rto, 2.2, raw);
    const R = x.R * x.grow, px = x.pos.x, pz = x.pos.y, py = x.h; // its platform floats at its height
    x.group.position.set(px, py, pz);
    // The pedestal, its rim in the state's colour; a waiting session's halo beating round it.
    if (ns < 64) {
      put(S.pedestals, ns, px, py, pz, R, 0.22, R); S.pedestals.setColorAt(ns, C.copy(PANEL).lerp(x.colour, 0.06)); of.pedestals[ns] = info;
      put(S.rims, ns, px, py + 0.23, pz, R, 2.2, R); S.rims.setColorAt(ns, C.copy(x.colour).multiplyScalar(receded ? 0.4 : 1));
      // A pool of its light on the floor round it.
      put(S.pools, ns, px, py - 0.04, pz, R * 2.6, 1, R * 2.6); S.pools.setColorAt(ns, C.copy(x.colour).multiplyScalar(receded ? 0.08 : 0.24));
      ns++;
    }
    // A ring of light over it, turning: segments in its colour, more of them lit the busier it is.
    { const lit = receded ? 4 : 6 + Math.round(8 * Math.min(1, x.act.reduce((a, b) => a + b, 0) / BARS * 3));
      for (let k = 0; k < 14 && nh < MAX.hud; k++) { if (k >= lit) continue; put(S.hud, nh, px, py + 0.7 + (x.lift || 0) * 0.3, pz, R + 0.3, R + 0.3, R + 0.3, (k / 14) * Math.PI * 2 + t * (receded ? 0.1 : 0.5)); S.hud.setColorAt(nh, C.copy(x.colour).multiplyScalar(receded ? 0.4 : 1)); nh++; } }
    if (S.beacons.has(s.sid)) { const b = S.beacons.get(s.sid); b.material.opacity = 0.14 + 0.16 * Math.max(0, Math.sin(t * 4.2)) ** 4; }
    {
    }
    const beat = needs ? Math.max(0, Math.sin(t * 4.2)) ** 6 : 0;
    x.halo.visible = needs; x.halo.scale.setScalar(R + 0.35 + beat * 0.4); x.halo.position.y = 0.1; x.halo.material.emissiveIntensity = 0.6 + beat * 1.2;
    // The burst: standing over its pedestal, turning; lifted while it waits; each ray a bar of recent activity.
    x.lift = spring(x.lift, needs ? 0.7 : 0, 3, raw);
    const cy = py + 2.5 + x.lift + 0.12 * Math.sin(t * 0.9 + x.seed);
    // It faces you, turning a little either way (more while it works), so it reads as Claude's spark, not a bundle.
    x.spin = Math.atan2(camera.position.x - px, camera.position.z - pz) + Math.sin(t * (s.state === "working" ? 0.9 : 0.4) + x.seed) * 0.45;
    const wob = stalled ? Math.sin(t * 9 + x.seed) * 0.05 : 0;
    for (let i = 0; i < RAYS && nr < MAX.rays; i++) {
      const a = x.act[BARS - RAYS + i] || 0;
      const to = receded ? 0.35 : 0.55 + 0.75 * Math.sqrt(a) + (needs ? 0.25 + beat * 0.25 : 0);
      x.rayLen[i] = spring(x.rayLen[i], to * (0.9 + 0.12 * Math.sin(t * 2 + i * 1.7)), 5, raw);
      put(S.rays, nr, px, cy, pz, 1.3 * x.grow, 1.35 * x.rayLen[i] * x.grow, 1.3 * x.grow, x.spin, (i / RAYS) * Math.PI * 2 + wob);
      S.rays.setColorAt(nr, C.copy(x.colour).multiplyScalar(receded ? 0.45 : 1)); of.rays[nr] = info; nr++;
    }
    x.ctx.position.set(0, cy - py, 0); x.ctx.rotation.y = t * 0.15; x.ctx.scale.setScalar(x.grow);
    // The activity, as a ring of 3D bars round the rim: oldest to newest, the newest brightest.
    for (let i = 0; i < BARS && nb < MAX.bars; i++) {
      const a = x.act[i] || 0, ang = (i / BARS) * Math.PI * 1.7 + Math.PI * 0.65, h = 0.06 + 1.3 * Math.sqrt(a) * x.grow;
      put(S.bars, nb, px + Math.cos(ang) * (R - 0.32), py + 0.22, pz + Math.sin(ang) * (R - 0.32), 0.17, h, 0.17, -ang);
      brand(Math.min(1, Math.sqrt(a)), C).multiplyScalar((receded ? 0.35 : 0.6) + 0.4 * (i / BARS)); // cyan low, violet high, the newest brightest
      S.bars.setColorAt(nb, C);
      of.bars[nb] = { sid: s.sid, title: s.name + " · activity", lines: ["tool calls across the window, a bar each, round the rim to the newest"] }; nb++;
    }
    // Its parts.
    for (const p of x.parts.values()) {
      p.scale = spring(p.scale, 1, 3, raw);
      const wx = px + p.p.x, wz = pz + p.p.y, sc = p.scale * x.grow;
      const parent = p.parent === "core" ? null : x.parts.get(p.parent);
      if (p.kind === "wf" && np < MAX.prisms) {
        const live = p.w.outcome === "running";
        put(S.prisms, np, wx, py + 0.22, wz, 0.62 * sc, 0.42 * sc, 0.62 * sc, t * 0.2);
        S.prisms.setColorAt(np, C.copy(VIOLET).multiplyScalar(live ? 1 : 0.45)); of.prisms[np] = { title: p.title, lines: p.lines }; np++;
        // Its phases: beads in an arc over it, done in lilac, the one under way lit and beating, the rest dark.
        const ph = (p.w.phases || []).slice(0, 10);
        ph.forEach((q, k) => {
          if (nbd >= MAX.beads) return;
          const ang = (k / Math.max(1, ph.length - 1) - 0.5) * 2.2;
          const lit = q.state === "now" ? 0.14 + 0.05 * Math.sin(t * 6) : 0.11;
          put(S.beads, nbd, wx + Math.sin(ang) * 0.75 * sc, py + 0.95 + Math.cos(ang) * 0.35, wz, lit * sc, lit * sc, lit * sc);
          S.beads.setColorAt(nbd, C.set(q.state === "done" ? P.violet : q.state === "now" ? P.white : "#2c2845")); nbd++;
        });
        link(px, cy - 0.6, pz, wx, py + 0.64 * sc + 0.22, wz, C2.copy(VIOLET).multiplyScalar(0.8), live);
      } else if (p.kind === "agent" && na < MAX.agents) {
        const st = p.a.state, r = (st === "done" ? 0.2 : 0.3) * sc;
        const bob = st === "active" ? Math.abs(Math.sin(t * 3 + p.key.length)) * 0.18 : 0, ay = py + 0.22 + r + 0.15 + bob;
        put(S.agents, na, wx, ay, wz, r, r, r);
        S.agents.setColorAt(na, C.set(AGENT_COLOUR[st] || P.dim)); of.agents[na] = { title: (st === "active" ? "● " : st === "tool" ? "◐ " : st === "done" ? "✓ " : "○ ") + p.title, lines: p.lines }; na++;
        const wire = C2.set(AGENT_COLOUR[st] || P.dim).multiplyScalar(0.8), live = st === "active" || st === "tool";
        if (parent) link(px + parent.p.x, py + 0.5, pz + parent.p.y, wx, ay, wz, wire, live);
        else link(px, cy - 0.6, pz, wx, ay, wz, wire, live);
      } else if (p.kind === "tasks") {
        // A tower of blocks, a task each (twenty at most): done in sage, under way lit and beating, to do dark.
        const T = p.t, n = Math.min(20, T.total), doing = T.open.filter((q) => q.status === "in_progress").length;
        const dn = Math.round((T.done / T.total) * n), dg = Math.min(n - dn, Math.ceil((doing / T.total) * n));
        for (let k = 0; k < n && nt < MAX.tiles; k++) {
          put(S.tiles, nt, wx, py + 0.22 + k * 0.16 * sc, wz, 0.62 * sc, 0.13 * sc, 0.62 * sc, 0.4);
          S.tiles.setColorAt(nt, k < dn ? GREEN : k < dn + dg ? C2.copy(WHITE).multiplyScalar(0.75 + 0.25 * Math.sin(t * 5)) : NAVY); of.tiles[nt] = { title: p.title, lines: p.lines }; nt++;
        }
        link(px, cy - 0.6, pz, wx, py + 0.22 + n * 0.16 * sc, wz, C2.copy(GREEN).multiplyScalar(0.7));
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
  // Comets: a head and a tail that thins and fades, from its colour to the monument's cyan as it lands.
  let npl = 0;
  for (const q of S.pellets) {
    if (q.p < 0) continue;
    for (let k = 0; k < MAX.trail && npl < MAX.pellets * MAX.trail; k++) {
      const p = Math.max(0, q.p - k * 0.025), a = q.x.pos, e = Math.sin(Math.PI * p), u = 1 - p, sz = 0.13 * (1 - k / MAX.trail);
      put(S.pelletMesh, npl, a.x * u, (q.x.h + 2.5 + q.x.lift) * u + e * (2.5 + q.x.R * 0.4), a.y * u, sz, sz, sz);
      S.pelletMesh.setColorAt(npl, C.copy(q.x.colour).lerp(CYAN, p).multiplyScalar(1 - k / (MAX.trail + 1))); npl++;
    }
  }
  const done = (mesh, n, ofs) => { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; if (ofs) mesh.userData.of = ofs; };
  done(S.rays, nr, of.rays); done(S.bars, nb, of.bars); done(S.tiles, nt, of.tiles); done(S.agents, na, of.agents); done(S.beads, nbd); done(S.prisms, np, of.prisms); done(S.pedestals, ns, of.pedestals); done(S.rims, ns); done(S.pools, ns); done(S.hud, nh); done(S.flow, nf); done(S.pelletMesh, npl);
  S.links.geometry.setDrawRange(0, nl * 2); S.links.geometry.attributes.position.needsUpdate = true; S.links.geometry.attributes.color.needsUpdate = true;

  S.composer.render();
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
    tmp.set(x.pos.x, x.h + 4.3 + x.lift, x.pos.y);
    const dist = tmp2.copy(tmp).sub(camera.position).length();
    tmp.project(camera);
    return { x, dist, on: tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2, sx: (tmp.x * 0.5 + 0.5) * w, sy: (-tmp.y * 0.5 + 0.5) * h };
  }).sort((a, b) => (b.x.s.state === "needs") - (a.x.s.state === "needs") || busy(b.x) - busy(a.x) || a.dist - b.dist);
  const toward = Math.atan2(camera.position.x, camera.position.z);
  tmp.set(Math.sin(toward) * 4.9, S.gaugeY, Math.cos(toward) * 4.9).project(camera);
  const cx = (tmp.x * 0.5 + 0.5) * w, cy = (-tmp.y * 0.5 + 0.5) * h;
  S.core.style.left = cx.toFixed(1) + "px"; S.core.style.top = (cy + 8).toFixed(1) + "px";
  const placed = [{ x: cx, y: cy + 8, w: 280, h: 34 }];
  // The A's own room, as the screen sees it: no label lands on it.
  { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [ax, ay] of [[-4.2, -3.2], [4.2, -3.2], [-4.2, 3.2], [4.2, 3.2]]) { tmp.set(ax * Math.cos(toward), ay, -ax * Math.sin(toward)).project(camera); const sx = (tmp.x * 0.5 + 0.5) * w, sy = (-tmp.y * 0.5 + 0.5) * h; x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); }
    placed.push({ x: (x0 + x1) / 2, y: y0, w: x1 - x0, h: y1 - y0 }); }
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
