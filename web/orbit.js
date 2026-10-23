// The orbit view, "Synapse": the whole fleet as one living constellation, on three.js (vendor/, served at /three.js)
// with its bloom (vendor/three-addons, at /three-addons/).
//
// At the centre, Answertree's A turns slowly, ringed by two tilted gauge orbits (the five hours, the week). Every
// session is a glowing soma at a distance from the A that says how urgent it is (waiting on you nearest, finished
// furthest), joined to the A by an axon. Round each soma its parts are nodes on luminous fibres: the main thread, each
// workflow (an octahedron, its phases a string of pearls), its agents, its open tasks (diamonds) and a done diamond.
// What happens travels: each tool call is a pulse from the agent that made it, down its fibres and the axon into the
// A, which flares as they land; output trickles back out in violet; a finished task runs green; a waiting session
// beats amber and calls. Physics lays it all out in 3D so nothing touches. Text is almost nothing: a tag on each
// session waiting on you, a legend, a line under the A. Hover anything and its branch lights up, the rest dims and a
// card says what it is; click a session to open it, anything else to fly to its cluster. Less motion for those who ask.
import * as THREE from "/three.js";
import { EffectComposer } from "/three-addons/EffectComposer.js";
import { RenderPass } from "/three-addons/RenderPass.js";
import { UnrealBloomPass } from "/three-addons/UnrealBloomPass.js";
import { OutputPass } from "/three-addons/OutputPass.js";

// ── palette ──
const P = { bg: "#0a0f1a", panel: "#151b23", line: "#262d37", text: "#c6cdd7", white: "#f5f7fa", dim: "#6b7380", cyan: "#56cdd6", blue: "#61aaff", violet: "#be94ff", green: "#50c878", amber: "#e5b544", red: "#f0625c", done: "#3e805c", g1: "#25d8fc", g2: "#0075fc", g3: "#6c28fa", spark: "#bff4ff" };
const STATE_COLOUR = { needs: P.amber, stalled: P.red, working: P.green, justDone: P.green, yourTurn: P.blue, idle: P.dim, finished: P.done };
const STATE_GLOW = { needs: 1.0, stalled: 0.9, working: 0.9, justDone: 0.9, yourTurn: 0.7, idle: 0.35, finished: 0.2 };
const SHELL = { needs: 0.66, stalled: 0.76, yourTurn: 0.84, working: 0.94, justDone: 1.0, idle: 1.18, finished: 1.38 }; // urgency as distance from the A
const STATE_ORDER = ["needs", "stalled", "yourTurn", "working", "justDone", "idle", "finished"];
const STATE_WORD = { needs: "needs you", stalled: "stalled?", yourTurn: "your turn", working: "working", justDone: "finished", idle: "idle", finished: "finished" };
const AGENT_COLOUR = { active: P.cyan, tool: P.white, quiet: "#3d6f78", done: "#2b4a52", stalled: P.red };
const AGENT_GLOW = { active: 1.1, tool: 1.8, quiet: 0.35, done: 0.15, stalled: 1.0 };
const AGENT_R = { active: 0.24, tool: 0.24, stalled: 0.24, quiet: 0.2, done: 0.15 };
const GRAD = [new THREE.Color(P.g1), new THREE.Color(P.g2), new THREE.Color(P.g3)];
const brand = (f, out = new THREE.Color()) => (f < 0.5 ? out.copy(GRAD[0]).lerp(GRAD[1], f * 2) : out.copy(GRAD[1]).lerp(GRAD[2], Math.min(1, (f - 0.5) * 2)));
const MAX = { soma: 64, wf: 160, phase: 640, agent: 768, task: 512, edges: 1536, pulses: 700, rings: 24, stars: 1200 };
const CORE = 7.2; // nothing comes nearer the A than this
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const motion = () => (still || document.body.classList.contains("calm") ? 0.3 : 1);
const spring = (now, to, k, dt) => now + (to - now) * (1 - Math.exp(-k * dt));
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };
const sum = (a) => (a || []).reduce((x, y) => x + y, 0);
const easeOutBack = (u, k = 1.4) => 1 + (k + 1) * Math.pow(u - 1, 3) + k * Math.pow(u - 1, 2);
let S = null;

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

// ── shaders ──
// Nodes: one material for every kind, lit by a fixed light, an own glow and a rim, dimmed when not in the lit set,
// faded toward the background with depth so the far side reads further.
const DEPTH_FADE = "uniform float uNear; uniform float uFar; uniform vec3 uBg;\nvec3 fadeDepth(vec3 c, float d) { return mix(c, uBg, 0.55 * smoothstep(uNear, uFar, d)); }\n";
function nodeMaterial(rim) {
  return new THREE.ShaderMaterial({
    uniforms: { uRim: { value: rim }, uNear: S.fog.near, uFar: S.fog.far, uBg: S.fog.bg },
    vertexShader: `attribute vec3 aColor; attribute float aGlow; attribute float aDim;
      varying vec3 vN; varying vec3 vV; varying vec3 vCol; varying float vGlow; varying float vDim; varying float vDepth;
      void main() {
        vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vV = normalize(-mv.xyz); vCol = aColor; vGlow = aGlow; vDim = aDim; vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform float uRim; ${DEPTH_FADE}
      varying vec3 vN; varying vec3 vV; varying vec3 vCol; varying float vGlow; varying float vDim; varying float vDepth;
      void main() {
        vec3 n = normalize(vN);
        float diff = 0.35 + 0.65 * max(dot(n, normalize(vec3(0.4, 0.8, 0.5))), 0.0);
        float rim = pow(1.0 - abs(dot(n, normalize(vV))), 2.5);
        vec3 c = vCol * diff * 0.5 + vCol * vGlow * 0.5 + rim * mix(vCol, vec3(1.0), 0.35) * uRim * 0.7;
        c *= mix(0.18, 1.0, vDim);
        gl_FragColor = vec4(fadeDepth(c, vDepth), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
// Glowing points: pulses, coronas, stars (a soft disc; stars twinkle), and the rings of shockwaves and ripples (a band).
function pointsMaterial(mode, world) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: S.pxScale, uWorld: { value: world ? 1 : 0 }, uMode: { value: mode }, uTime: S.time },
    vertexShader: `attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
      uniform float uScale; uniform float uWorld; uniform float uMode; uniform float uTime; varying vec3 vCol; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = uWorld > 0.5 ? aSize * uScale / max(-mv.z, 0.1) : aSize;
        vCol = aColor; vA = aAlpha;
        if (uMode > 1.5) { float h = fract(sin(dot(position.xy, vec2(12.9898, 78.233))) * 43758.5453); vA *= 0.7 + 0.3 * sin(uTime * (0.5 + h) * 2.0 + h * 40.0); }
      }`,
    fragmentShader: `uniform float uMode; varying vec3 vCol; varying float vA;
      void main() {
        float d = length(gl_PointCoord * 2.0 - 1.0); if (d > 1.0) discard;
        float a = uMode > 0.5 && uMode < 1.5 ? smoothstep(0.78, 0.9, d) * (1.0 - smoothstep(0.92, 1.0, d)) : pow(1.0 - d, 1.6);
        gl_FragColor = vec4(vCol, a * vA);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function pointsMesh(max, mode, world) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
  g.setDrawRange(0, 0);
  const m = new THREE.Points(g, pointsMaterial(mode, world)); m.frustumCulled = false; S.scene.add(m);
  return m;
}
function setPoint(m, i, p, c, size, alpha) {
  const a = m.geometry.attributes;
  a.position.setXYZ(i, p.x, p.y, p.z); a.aColor.setXYZ(i, c.r, c.g, c.b); a.aSize.setX(i, size); a.aAlpha.setX(i, alpha);
}
function flushPoints(m, n) { m.geometry.setDrawRange(0, n); for (const k of ["position", "aColor", "aSize", "aAlpha"]) m.geometry.attributes[k].needsUpdate = true; }

// ── mount ──
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
  box.append(renderer.domElement);
  box.tabIndex = 0;
  const style = document.createElement("style");
  style.textContent = `.orbit .ochip{position:absolute;left:0;top:0;pointer-events:auto;cursor:pointer;white-space:nowrap;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:650;color:#ffd98a;background:#2a2108e6;border:1px solid #e5b544;box-shadow:0 0 14px #e5b54455}
.orbit .otag{position:absolute;left:0;top:0;pointer-events:none;white-space:nowrap;padding:1px 6px;border-radius:6px;font-size:10px;color:#c6cdd7;background:#151b23cc;animation:ofade .15s ease-out}
@keyframes ofade{from{opacity:0}to{opacity:1}}
.orbit .olegend{position:absolute;left:12px;bottom:10px;display:flex;gap:6px;opacity:.6;font-size:11px;color:#c6cdd7}.orbit .olegend:hover{opacity:1}
.orbit .olegend button{background:none;border:0;padding:2px 5px;color:inherit;font:inherit;cursor:pointer;display:flex;align-items:center;gap:5px;border-radius:6px}.orbit .olegend button.on{background:#ffffff14}
.orbit .olegend i{width:9px;height:9px;border-radius:50%;display:inline-block}.orbit .olegend span{display:none}.orbit .olegend button:hover span,.orbit .olegend button.on span{display:inline}
.orbit .opin{position:absolute;right:12px;top:12px;z-index:4;width:300px;max-width:calc(100% - 24px);background:#121821f2;border:1px solid #2a3a58;border-radius:12px;padding:10px 12px;font-size:12px;color:#c6cdd7;box-shadow:0 12px 34px #000c}
.orbit .opin b{color:#f5f7fa;font-size:13px}.orbit .opin .ogo{margin-top:8px;border:0;border-radius:999px;padding:5px 12px;font:600 12px system-ui;color:#fff;background:linear-gradient(135deg,#25d8fc,#0075fc 55%,#6c28fa);cursor:pointer}
.orbit .ocore{color:#6b7380;font-size:11px;opacity:.75;letter-spacing:.02em}.orbit .ocore.hot{color:#f0625c;opacity:1}
.orbit .omini{display:flex;height:4px;border-radius:2px;overflow:hidden;margin:4px 0;background:#262d37}.orbit .omini i{display:block;height:100%}
.orbit .ohelp{transition:opacity .6s}`;
  box.append(style);
  const labels = document.createElement("div"); labels.className = "olabels"; box.append(labels);
  const core = document.createElement("div"); core.className = "ocore"; labels.append(core);
  const tip = document.createElement("div"); tip.className = "otip"; tip.hidden = true; box.append(tip);
  const pin = document.createElement("div"); pin.className = "opin"; pin.hidden = true; box.append(pin);
  const legend = document.createElement("div"); legend.className = "olegend"; box.append(legend);
  const help = document.createElement("div"); help.className = "ohelp"; help.textContent = "drag · scroll · hover · click"; box.append(help);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, box.clientWidth && box.clientHeight ? box.clientWidth / box.clientHeight : 1, 0.5, 600);
  S = { box, hooks, renderer, scene, camera, labels, core, tip, pin, legend, help, t: 0, last: performance.now(), raf: 0, running: true,
    fog: { near: { value: 20 }, far: { value: 80 }, bg: { value: new THREE.Color(P.bg) } }, pxScale: { value: 600 }, time: { value: 0 },
    nodes: [], byKey: new Map(), sessions: new Map(), pulses: [], rings: [], tau: 1, asleep: false, quietFor: 0,
    view: { theta: 0.7, phi: 1.15, r: 40, fit: 40, zoom: 1, idleSince: performance.now(), dragV: 0, pivot: new THREE.Vector3(), pivotTo: new THREE.Vector3(), framed: false },
    hover: null, focus: null, filter: null, lit: null, flare: 0, fleetMax: 1, outMax: 1, chips: new Map(), tags: new Map(), layoutAt: 0, fitAt: 0, d: null, bloomStart: performance.now(), trickleAcc: new Map(), callAt: new Map(), quality: 0, needsSince: new Map() };

  // Background: the splash's navy, stars all round.
  const sky = document.createElement("canvas"); sky.width = sky.height = 512;
  { const g = sky.getContext("2d"), r = g.createRadialGradient(256, 210, 0, 256, 256, 420); r.addColorStop(0, "#1a2540"); r.addColorStop(0.45, "#0e1526"); r.addColorStop(1, "#05070c"); g.fillStyle = r; g.fillRect(0, 0, 512, 512); }
  S.skyTex = new THREE.CanvasTexture(sky); S.skyTex.colorSpace = THREE.SRGBColorSpace; scene.background = S.skyTex;
  S.stars = pointsMesh(MAX.stars, 2, false);
  { const c = new THREE.Color(), dimStar = new THREE.Color(P.text).multiplyScalar(0.6), v = new THREE.Vector3();
    for (let i = 0; i < MAX.stars; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, q = Math.sqrt(1 - u * u), r = 140 + Math.random() * 80, h = Math.random();
      c.copy(h < 0.075 ? GRAD[0] : h < 0.15 ? GRAD[2] : dimStar);
      setPoint(S.stars, i, v.set(r * q * Math.cos(a), r * u, r * q * Math.sin(a)), c, 1.4 * (devicePixelRatio || 1), 0.8);
    }
    flushPoints(S.stars, MAX.stars); }

  // The A: extruded, bevelled, its colour across the logo's gradient, turning; a glow behind it.
  scene.add(new THREE.HemisphereLight("#bfe8ff", P.bg, 0.9));
  const sun = new THREE.DirectionalLight("#ffffff", 0.8); sun.position.set(8, 12, 10); scene.add(sun);
  const aGeo = new THREE.ExtrudeGeometry(logoShapes(), { depth: 0.9, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 2, curveSegments: 14 });
  aGeo.center(); aGeo.computeBoundingBox();
  { const pos = aGeo.attributes.position, bb = aGeo.boundingBox, cols = new Float32Array(pos.count * 3), c = new THREE.Color();
    for (let k = 0; k < pos.count; k++) { brand((pos.getX(k) - bb.min.x) / (bb.max.x - bb.min.x), c); cols.set([c.r, c.g, c.b], k * 3); }
    aGeo.setAttribute("color", new THREE.BufferAttribute(cols, 3)); }
  S.aMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2, emissive: P.g2, emissiveIntensity: 0.3 });
  S.aMat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * 0.55;"); };
  S.logo = new THREE.Mesh(aGeo, S.aMat); scene.add(S.logo);
  S.radial = (() => { const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.35, "rgba(255,255,255,.45)"); r.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = r; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
  S.aGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: S.radial, color: P.g2, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending }));
  S.aGlow.scale.setScalar(15); scene.add(S.aGlow);

  // The gauge orbits: the five hours (thick, the logo's gradient, white then red as it fills) and the week (violet).
  const gaugeMat = (thick) => new THREE.ShaderMaterial({
    uniforms: { uPct: { value: 0 }, uMode: { value: thick ? 0 : 1 }, uHot: { value: 0 }, uPulse: { value: 1 }, uG1: { value: GRAD[0] }, uG2: { value: GRAD[1] }, uG3: { value: GRAD[2] }, uV: { value: new THREE.Color(P.violet) }, uW: { value: new THREE.Color(P.white) }, uR: { value: new THREE.Color(P.red) }, uT: { value: new THREE.Color(P.line) } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `uniform float uPct; uniform float uMode; uniform float uHot; uniform float uPulse; uniform vec3 uG1; uniform vec3 uG2; uniform vec3 uG3; uniform vec3 uV; uniform vec3 uW; uniform vec3 uR; uniform vec3 uT; varying vec2 vUv;
      void main() {
        if (vUv.x > uPct) { gl_FragColor = vec4(uT, 0.25); return; }
        vec3 c = uMode < 0.5 ? (vUv.x < 0.5 ? mix(uG1, uG2, vUv.x * 2.0) : mix(uG2, uG3, vUv.x * 2.0 - 1.0)) : uV;
        if (uHot > 1.5) c = uR; else if (uHot > 0.5) c = uW;
        gl_FragColor = vec4(c * 1.4 * uPulse, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
  });
  S.gauges = [[5.9, 0.07, 1.25, 0.35], [6.5, 0.04, 1.95, -0.45]].map(([r, tube, rx, rz], i) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 160), gaugeMat(i === 0));
    const holder = new THREE.Group(); holder.rotation.set(rx, 0, rz); holder.add(m); scene.add(holder);
    m.userData.pct = 0; m.userData.to = -1; m.visible = false; return m;
  });

  // Node meshes, one draw each.
  S.geos = [aGeo];
  const mesh = (geo, rim, max) => { const m = new THREE.InstancedMesh(geo, nodeMaterial(rim), max); for (const [k, n] of [["aColor", 3], ["aGlow", 1], ["aDim", 1]]) m.geometry.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage)); m.count = 0; m.frustumCulled = false; scene.add(m); S.geos.push(geo); return m; };
  S.mesh = {
    soma: mesh(new THREE.IcosahedronGeometry(1, 3), 0.8, MAX.soma),
    wf: mesh(new THREE.OctahedronGeometry(1), 0.6, MAX.wf),
    phase: mesh(new THREE.SphereGeometry(1, 12, 8), 0.4, MAX.phase),
    agent: mesh(new THREE.SphereGeometry(1, 14, 10), 0.5, MAX.agent),
    task: mesh(new THREE.BoxGeometry(1, 1, 1), 0.5, MAX.task),
  };
  S.corona = pointsMesh(MAX.soma, 0, true);
  // The context ring round each soma: one torus facing the camera, its lit arc split by what fills the context.
  const ctxGeo = new THREE.TorusGeometry(1, 0.05, 6, 96); S.geos.push(ctxGeo);
  S.ctx = new THREE.InstancedMesh(ctxGeo, new THREE.ShaderMaterial({
    vertexShader: `attribute float aPct; attribute vec4 aEnds; attribute vec3 aC0; attribute vec3 aC1; attribute vec3 aC2; attribute vec3 aC3; attribute float aDim;
      varying vec2 vUv; varying float vPct; varying vec4 vEnds; varying vec3 vC0; varying vec3 vC1; varying vec3 vC2; varying vec3 vC3; varying float vDim;
      void main(){ vUv = uv; vPct = aPct; vEnds = aEnds; vC0 = aC0; vC1 = aC1; vC2 = aC2; vC3 = aC3; vDim = aDim; gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 vUv; varying float vPct; varying vec4 vEnds; varying vec3 vC0; varying vec3 vC1; varying vec3 vC2; varying vec3 vC3; varying float vDim;
      void main(){
        float a = mix(0.25, 1.0, vDim);
        if (vUv.x > vPct) { gl_FragColor = vec4(0.149, 0.176, 0.216, 0.35 * a); return; }
        vec3 c = vUv.x < vEnds.x ? vC0 : vUv.x < vEnds.y ? vC1 : vUv.x < vEnds.z ? vC2 : vC3;
        gl_FragColor = vec4(c * 1.2 * a, a);
      }`,
    transparent: true, depthWrite: false,
  }), MAX.soma);
  for (const [k, n] of [["aPct", 1], ["aEnds", 4], ["aC0", 3], ["aC1", 3], ["aC2", 3], ["aC3", 3], ["aDim", 1]]) S.ctx.geometry.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(MAX.soma * n), n).setUsage(THREE.DynamicDrawUsage));
  S.ctx.count = 0; S.ctx.frustumCulled = false; scene.add(S.ctx);

  // The fibres: every edge a quadratic curve of 11 points, drawn as a ribbon a few pixels wide, all in one mesh.
  const ne = MAX.edges, vtx = ne * 22, rg = new THREE.BufferGeometry();
  for (const [k, n] of [["position", 3], ["aOther", 3], ["aSide", 1], ["aColor", 3], ["aAlpha", 1], ["aWidth", 1]]) rg.setAttribute(k, new THREE.BufferAttribute(new Float32Array(vtx * n), n).setUsage(THREE.DynamicDrawUsage));
  const idx = new Uint32Array(ne * 10 * 6);
  for (let e = 0, o = 0; e < ne; e++) for (let k = 0; k < 10; k++) { const a = e * 22 + k * 2; idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], o); o += 6; }
  rg.setIndex(new THREE.BufferAttribute(idx, 1)); rg.setDrawRange(0, 0);
  S.res = { value: new THREE.Vector2(1, 1) };
  S.ribbon = new THREE.Mesh(rg, new THREE.ShaderMaterial({
    uniforms: { uRes: S.res, uScale: S.pxScale, uNear: S.fog.near, uFar: S.fog.far, uBg: S.fog.bg },
    vertexShader: `attribute vec3 aOther; attribute float aSide; attribute vec3 aColor; attribute float aAlpha; attribute float aWidth;
      uniform vec2 uRes; uniform float uScale; varying vec3 vCol; varying float vA; varying float vSide; varying float vDepth;
      void main(){
        vec4 a = viewMatrix * vec4(position, 1.0), b = viewMatrix * vec4(aOther, 1.0);
        vec4 ca = projectionMatrix * a, cb = projectionMatrix * b;
        vec2 sa = ca.xy / ca.w * uRes * 0.5, sb = cb.xy / cb.w * uRes * 0.5, d = sb - sa;
        vec2 dir = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
        float px = clamp(aWidth * uScale / max(-a.z, 0.1), 1.6, 7.0);
        ca.xy += vec2(-dir.y, dir.x) * aSide * px / (uRes * 0.5) * ca.w;
        gl_Position = ca; vCol = aColor; vA = aAlpha; vSide = aSide; vDepth = -a.z;
      }`,
    fragmentShader: `${DEPTH_FADE} varying vec3 vCol; varying float vA; varying float vSide; varying float vDepth;
      void main(){ float s = 1.0 - abs(vSide); float a = vA * (0.45 + 0.55 * s * s) * (1.0 - 0.55 * smoothstep(uNear, uFar, vDepth)); gl_FragColor = vec4(vCol, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, // built in screen space: either winding
  }));
  S.ribbon.frustumCulled = false; scene.add(S.ribbon);
  S.pulseMesh = pointsMesh(MAX.pulses * 3, 0, true);
  S.ringMesh = pointsMesh(MAX.rings, 1, true);

  // Bloom: cores, pulses and fibre centres glow.
  S.composer = new EffectComposer(renderer);
  S.composer.addPass(new RenderPass(scene, camera));
  S.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.4, 0.72);
  S.composer.addPass(S.bloom);
  S.composer.addPass(new OutputPass());

  wireInput();
  S.ro = new ResizeObserver(resize); S.ro.observe(box);
  S.inView = true;
  S.io = new IntersectionObserver((es) => { if (!S) return; S.inView = es[0].isIntersecting; setRunning(S.inView && !document.hidden); });
  S.io.observe(box);
  S.onVis = () => { if (S) setRunning(S.inView && !document.hidden); };
  document.addEventListener("visibilitychange", S.onVis);
  setTimeout(() => { if (S) S.help.style.opacity = "0"; }, 4000);
  S.raf = requestAnimationFrame(frame);
}

// Start or stop the one animation loop: starting cancels whatever is queued, so loops never pile up.
function setRunning(on) {
  if (on === S.running) return;
  S.running = on;
  cancelAnimationFrame(S.raf); S.raf = 0;
  if (on) { S.last = performance.now(); S.raf = requestAnimationFrame(frame); }
}
function resize() {
  if (!S) return;
  const { box, renderer, camera } = S, w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  const base = Math.min(devicePixelRatio || 1, 2), ratio = [base, Math.min(base, 1.5), Math.min(base, 1.25), Math.min(base, 1)][S.quality];
  renderer.setPixelRatio(ratio); renderer.setSize(w, h, false);
  S.composer.setPixelRatio(ratio); S.composer.setSize(w, h);
  S.bloom.resolution.set(w / 2, h / 2);
  camera.aspect = w / h; camera.fov = camera.aspect < 0.8 ? 48 : 40; camera.updateProjectionMatrix();
  S.res.value.set(w * ratio, h * ratio);
  S.pxScale.value = (h * ratio) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  reheat(0.3);
}

export function unmount() {
  if (!S) return;
  cancelAnimationFrame(S.raf); S.ro.disconnect(); S.io.disconnect();
  document.removeEventListener("visibilitychange", S.onVis);
  document.removeEventListener("keydown", S.onKey);
  S.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
  for (const g of S.geos) g.dispose();
  S.skyTex.dispose(); S.radial.dispose();
  S.composer.dispose(); S.renderer.dispose(); S.renderer.forceContextLoss();
  S.box.replaceChildren();
  S = null;
}

// ── the graph from a state ──
// Every node keyed so it keeps its place from one state to the next. Each non-soma node hangs from one parent, and
// each soma from the A by its axon: the edges are exactly the parent links.
function want(list, key, kind, sid, parent, data, extra = {}) { list.push({ key, kind, sid, parent, data, ...extra }); }
function graphOf(s) {
  const out = [], sk = "s:" + s.sid, R = s.roster || { workflows: [], agents: [], finished: 0 };
  want(out, sk, "soma", s.sid, null, s);
  const seen = new Map();
  const agentKey = (wf, a) => { const k = "ag:" + s.sid + ":" + (wf || "") + ":" + a.label, n = seen.get(k) || 0; seen.set(k, n + 1); return n ? k + "#" + n : k; };
  // Done agents under one parent: four shown, the rest folded into a bead.
  const agents = (list, parentKey, wf, folded = 0) => {
    let done = 0;
    for (const a of list) {
      if (a.state === "done" && ++done > 4) { folded++; continue; }
      want(out, agentKey(wf, a), "agent", s.sid, parentKey, a, { wf: wf || undefined });
    }
    return folded;
  };
  if (R.main) want(out, "main:" + s.sid, "main", s.sid, sk, R.main);
  const wfSeen = new Map();
  for (const w of R.workflows || []) {
    const k0 = "wf:" + s.sid + ":" + w.name, nth = wfSeen.get(k0) || 0, wk = nth ? k0 + "#" + nth : k0;
    wfSeen.set(k0, nth + 1);
    want(out, wk, "wf", s.sid, sk, w);
    let prev = wk;
    (w.phases || []).slice(0, 12).forEach((p, i) => { const pk = "ph:" + wk + ":" + i; want(out, pk, "phase", s.sid, prev, p, { wf: wk, index: i }); prev = pk; });
    const folded = agents(w.agents || [], wk, wk);
    if (folded || w.more) want(out, "fold:" + wk, "fold", s.sid, wk, { n: folded, more: w.more || 0 });
  }
  const folded = agents(R.agents || [], sk, "", R.finished || 0);
  if (folded) want(out, "fold:" + sk, "fold", s.sid, sk, { n: folded, more: 0 });
  const T = s.tasks;
  if (T) {
    for (const t of (T.open || []).slice(0, 8)) want(out, "tk:" + s.sid + ":" + hash(t.text).toString(36), "task", s.sid, sk, t);
    if (T.done > 0) want(out, "tdone:" + s.sid, "tdone", s.sid, sk, T);
  }
  return out;
}

function newNode(w, now) {
  const parent = w.parent ? S.byKey.get(w.parent) : null;
  const n = { key: w.key, kind: w.kind, sid: w.sid, parent, data: w.data, wf: w.wf, index: w.index, p: new THREE.Vector3(), v: new THREE.Vector3(), disp: new THREE.Vector3(), f: new THREE.Vector3(),
    r: w.kind === "soma" ? 0.65 : 0.2, mass: w.kind === "soma" ? 4 : w.kind === "wf" ? 2 : 1, col: new THREE.Color(), colTo: new THREE.Color(), dim: 1, dimTo: 1,
    born: now, delay: 0, dying: 0, missing: 0, flash: 0, sparkSum: sum(w.data && w.data.spark), tool: (w.data && w.data.tool) || "", depth: parent ? parent.depth + 1 : 0 };
  if (parent) {
    const u = parent.p.lengthSq() > 0.01 ? parent.p.clone().normalize() : new THREE.Vector3(0, 0, 1);
    n.p.copy(parent.p).addScaledVector(u, 0.4).add(new THREE.Vector3(hash(w.key) - 0.5, hash(w.key + "y") - 0.5, hash(w.key + "z") - 0.5).multiplyScalar(0.4));
    n.disp.copy(parent.disp);
  }
  return n;
}

export function update(d) {
  if (!S) return;
  const now = performance.now(), first = !S.d;
  S.d = d;
  const list = d.sessions || [];
  // Fleet-wide figures: the busiest session's recent tool calls and output, to scale each session against.
  const recent = (s, k, n) => sum(((s.timeline && s.timeline[k]) || []).slice(-n));
  S.fleetMax = Math.max(1, ...list.map((s) => recent(s, "tools", 5)));
  S.outMax = Math.max(1, ...list.map((s) => recent(s, "out", 2)));
  const fleetRate = sum(list.map((s) => recent(s, "tools", 5)));
  S.rateMax = Math.max(S.rateMax || 1, fleetRate); S.fleetRate = fleetRate / S.rateMax;
  // Burn share: each session's part of the output in the five-hour window.
  const burn = d.burn, outSums = new Map(list.map((s) => [s.sid, sum(s.timeline && s.timeline.out)])), fleetOut = sum([...outSums.values()]) || 1;
  const top = new Map(((burn && burn.top) || []).map((b) => [b.sid, b.out]));
  const restOut = sum(list.filter((s) => !top.has(s.sid)).map((s) => outSums.get(s.sid))) || 1;
  const shareOf = (s) => (burn && burn.total ? (top.has(s.sid) ? top.get(s.sid) / burn.total : ((burn.rest || 0) / burn.total) * (outSums.get(s.sid) / restOut)) : outSums.get(s.sid) / fleetOut);
  const wanted = list.flatMap(graphOf), keys = new Set(wanted.map((w) => w.key)), somaPrev = [];
  let changed = false;
  for (const w of wanted) {
    let n = S.byKey.get(w.key);
    const fresh = !n;
    if (fresh) {
      n = newNode(w, now);
      if (w.kind === "soma") seedSoma(n, list.length);
      S.byKey.set(w.key, n); S.nodes.push(n); changed = true;
      if (w.kind === "soma" && !first) ring(n.p, P.white, 0, 3, 700);
    } else if (n.dying) { n.dying = 0; n.born = now; }
    n.missing = 0;
    const prev = fresh ? null : n.data;
    n.data = w.data; n.parent = w.parent ? S.byKey.get(w.parent) : null; n.wf = w.wf;
    if (w.kind === "soma") { somaState(n, w.data, now, shareOf(w.data), first); somaPrev.push([n, prev]); }
    else if (!first) events(n, prev, w.data);
  }
  // A session's own events after its agents', so its tool calls not traced to an agent are counted once.
  if (!first) for (const [n, prev] of somaPrev) events(n, prev, n.data);
  // Gone: agents and tasks only after two states without them; a gone session takes its cluster with it.
  for (const n of S.nodes) if (!keys.has(n.key) && !n.dying) {
    n.missing++;
    const soft = n.kind === "agent" || n.kind === "task";
    if (!soft || n.missing >= 2 || !keys.has("s:" + n.sid)) { n.dying = now; changed = true; if (n.kind === "soma") ring(n.p, P.violet, 0, 3.2, 700); }
  }
  if (changed) { reheat(1); S.nodes.sort((a, b) => a.depth - b.depth); }
  // The first state: settle out of sight, then bloom open from the A.
  if (first) { for (let k = 0; k < 360; k++) step(1 / 60, 1); S.tau = 0.4; S.bloomStart = now; for (const n of S.nodes) n.delay = 35 * n.depth + 12 * rankOf(n); }
  // The gauges.
  const lims = (d.account && d.account.limits) || [], five = lims.find((l) => /^5h$|five/i.test(l.label)), week = lims.find((l) => /^7d$|week/i.test(l.label));
  S.gauges[0].userData.to = five ? five.pct / 100 : -1; S.gauges[1].userData.to = week ? week.pct / 100 : -1;
  S.core.textContent = !list.length ? "no sessions" : five ? "5h " + five.pct + "%" + (week ? " · wk " + week.pct + "%" : "") : "";
  S.core.classList.toggle("hot", !!(d.five && d.five.urgent));
  renderLegend(list);
  S.tipKey = null; // the card is built again with the new figures
  if (S.focus) renderPin();
}
// The order sessions bloom in: those waiting on you first, then the busiest.
function rankOf(n) {
  const somas = S.nodes.filter((m) => m.kind === "soma").sort((a, b) => STATE_ORDER.indexOf(S.sessions.get(a.sid).shown) - STATE_ORDER.indexOf(S.sessions.get(b.sid).shown) || S.sessions.get(b.sid).share - S.sessions.get(a.sid).share);
  return Math.max(0, somas.findIndex((m) => m.sid === n.sid));
}

// A new soma takes the free direction furthest from the others on a Fibonacci sphere, at its shell.
const FIB = Array.from({ length: 64 }, (_, i) => { const y = 0.8 - (1.6 * i) / 63, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5)); return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r); });
function seedSoma(n, count) {
  const taken = S.nodes.filter((m) => m.kind === "soma" && !m.dying).map((m) => m.p.clone().normalize());
  let best = FIB[0], bestScore = -Infinity;
  for (const f of FIB) { const near = taken.length ? Math.max(...taken.map((t) => t.dot(f))) : -1, score = -near + hash(n.key + f.x) * 1e-3; if (score > bestScore) { bestScore = score; best = f; } }
  // Stretched to the screen's shape, so on a tall screen they spread up it rather than round its middle.
  const ax = ellipse();
  n.p.set(best.x * ax.x, best.y * ax.y, best.z * ax.z).normalize().multiplyScalar(11 + 1.2 * Math.sqrt(count));
}
// A session's shown state changes only once the new one has held for 1.2 s (finished to working at once): no yo-yo.
function somaState(n, s, now, share, first) {
  let st = S.sessions.get(s.sid);
  const fresh = !st;
  if (fresh) { st = { shown: s.state, raw: s.state, rawSince: now, share: 0, rate: 0, children: 0, attributed: 0 }; S.sessions.set(s.sid, st); }
  if (s.state !== st.raw) { st.raw = s.state; st.rawSince = now; }
  if (first || fresh) setShown(n, st, st.raw, now, false);
  else if (st.raw === "working" && st.shown === "finished") setShown(n, st, st.raw, now, true);
  st.share = share;
  st.rate = sum(((s.timeline && s.timeline.tools) || []).slice(-5)) / S.fleetMax;
}
function setShown(n, st, state, now, wave) {
  st.shown = state;
  if (state === "needs") { if (!S.needsSince.has(n.sid)) S.needsSince.set(n.sid, now); } else S.needsSince.delete(n.sid);
  if (wave) { ring(n.p, STATE_COLOUR[state], 0, 3, motion() < 1 ? 300 : 700); reheat(0.4); }
}

// What changed in a node since the last state, as pulses and flashes along the graph.
function events(n, prev, cur) {
  if (n.kind === "agent" || n.kind === "main") {
    const s = sum(cur.spark), was = n.sparkSum;
    n.sparkSum = s;
    if (cur.tool && cur.tool !== n.tool) n.flash = 1;
    n.tool = cur.tool || "";
    if (prev && s > was) {
      const k = Math.min(2, s - was), st = S.sessions.get(n.sid);
      if (st) st.attributed += k;
      for (let i = 0; i < k; i++) pulseUp(n, P.spark, 0.45, 7, i * 120);
      n.flash = 1;
    }
    return;
  }
  if (!prev) return;
  if (n.kind === "soma") {
    const tools = (x) => sum(((x.timeline && x.timeline.tools) || []).slice(-3));
    const st = S.sessions.get(n.sid), extra = Math.max(0, tools(cur) - tools(prev) - ((st && st.attributed) || 0));
    if (st) st.attributed = 0;
    const from = S.byKey.get("main:" + n.sid) || n;
    for (let i = 0; i < Math.min(6, extra); i++) pulseUp(from, P.spark, 0.45, 7, i * 120);
    if (cur.fails && (!prev.fails || cur.fails.n > prev.fails.n)) pulseUp(n, P.red, 0.5, 5, 0, true);
    const prs = (cur.prs || []).length, prsWas = (prev.prs || []).length;
    const marks = (cur.timeline && cur.timeline.marks) || [], marksWas = ((prev.timeline && prev.timeline.marks) || []).length;
    if (prs > prsWas || marks.length > marksWas) for (let i = 0; i < 3; i++) pulseUp(n, prs > prsWas ? P.blue : (marks.at(-1) || {}).c || P.violet, 0.45, 7, i * 90);
  } else if (n.kind === "tdone" && prev.done < cur.done) {
    pulseUp(n, P.green, 0.5, 7, 0); n.pop = 1;
    S.greenUntil = performance.now() + 400;
  } else if (n.kind === "phase" && prev.state === "now" && cur.state === "done") {
    const wf = n.wf ? S.byKey.get(n.wf) : null, next = n.wf ? S.byKey.get("ph:" + n.wf + ":" + (n.index + 1)) : null;
    if (next) pulseDown(next, P.white, 0.4, 9);
    if (wf) pulseUp(wf, P.violet, 0.4, 7, 0);
  } else if (n.kind === "wf" && prev.outcome === "running" && cur.outcome !== "running") ring(n.p, cur.outcome === "failed" ? P.red : P.green, 0, 2.2, 600);
}

// ── pulses ──
// A pulse runs along a node's edge (t from 0 at its parent to 1 at it) and on along the next edge of its route.
const routeUp = (n) => { const r = []; for (let m = n; m; m = m.parent) r.push(m); return r; }; // up to the soma, then its axon
function pulseUp(n, colour, size, speed, delay, stutter) { addPulse({ route: routeUp(n), i: 0, t: 1, dir: -1, col: new THREE.Color(colour), size, speed, at: performance.now() + delay, stutter, land: true }); }
function pulseDown(n, colour, size, speed) { addPulse({ route: routeUp(n).reverse(), i: 0, t: 0, dir: 1, col: new THREE.Color(colour), size, speed, at: performance.now(), land: false }); }
function trickle(n) { addPulse({ route: [n], i: 0, t: 0, dir: 1, col: new THREE.Color(P.violet), size: 0.28, speed: 5, at: performance.now(), land: false, trickle: true }); }
function addPulse(p) { if (S.pulses.length >= (motion() < 1 ? 200 : MAX.pulses)) S.pulses.shift(); S.pulses.push(p); }
function ring(at, colour, r0, r1, dur, follow) { if (S.rings.length >= MAX.rings) S.rings.shift(); S.rings.push({ at: at.clone(), follow, col: new THREE.Color(colour), r0, r1, t0: performance.now(), dur }); }

// ── physics ──
function reheat(t) { if (!S) return; S.tau = Math.max(S.tau, t); S.asleep = false; S.quietFor = 0; }
const ELL = new THREE.Vector3();
// The somas' shells as an ellipsoid round the world's y, tall on a tall screen and wide on a wide one.
function ellipse() { const f = THREE.MathUtils.clamp((S.camera.aspect - 0.75) / (1.3 - 0.75), 0, 1); return ELL.set(0.8 + 0.35 * f, 1.5 - 0.78 * f, 0.8 + 0.35 * f); }
const REST = { main: 1.3, wf: 2.4, agent: 1.7, task: 1.4, tdone: 1.0 }; // from the soma, plus its radius
const TMP = new THREE.Vector3(), TMP2 = new THREE.Vector3(), U = new THREE.Vector3();
function step(h, tauOverride) {
  const tau = tauOverride || S.tau, live = S.nodes.filter((n) => !n.dying), somas = live.filter((n) => n.kind === "soma");
  const N = somas.length, g = THREE.MathUtils.clamp(1.12 - 0.011 * N, 0.8, 1.1), Rbase = 11 + 1.2 * Math.sqrt(Math.max(1, N)), ax = ellipse();
  for (const n of live) n.f.set(0, 0, 0);
  // Level 1: each soma to its state's shell; off each other; waiting ones (and stalled ones) gathered together.
  for (const s of somas) {
    const st = S.sessions.get(s.sid), shown = st ? st.shown : "working", d = TMP.copy(s.p).normalize();
    const Rs = (Rbase * SHELL[shown]) / Math.sqrt((d.x / ax.x) ** 2 + (d.y / ax.y) ** 2 + (d.z / ax.z) ** 2);
    s.f.addScaledVector(d, 2.2 * (Rs - s.p.length()) * tau);
    const ey = s.p.y / ax.y / Math.max(0.001, Math.hypot(s.p.x / ax.x, s.p.y / ax.y, s.p.z / ax.z));
    if (Math.abs(ey) > 0.85) s.f.y -= Math.sign(ey) * 15 * (Math.abs(ey) - 0.85) * tau; // nothing right over or under the A
    if (shown === "needs" || shown === "stalled") {
      const same = somas.filter((o) => o !== s && S.sessions.get(o.sid) && S.sessions.get(o.sid).shown === shown);
      if (same.length) { TMP2.set(0, 0, 0); for (const o of same) TMP2.add(o.p); TMP2.divideScalar(same.length).sub(s.p); s.f.addScaledVector(TMP2, 0.15 * tau); }
    }
  }
  for (let i = 0; i < somas.length; i++) for (let j = i + 1; j < somas.length; j++) {
    const a = somas[i], b = somas[j], d = TMP.subVectors(b.p, a.p), dist = Math.max(0.01, d.length()), min = (a.rc || 3) + (b.rc || 3) + 1;
    const f = dist < min ? (min - dist) * 16 : (30 * g * g) / (dist * dist);
    d.multiplyScalar(f / dist); a.f.addScaledVector(d, -0.5 * tau); b.f.addScaledVector(d, 0.5 * tau);
  }
  // Level 2: each part springs to what it hangs from, opens away from the A, and keeps off the rest of its cluster.
  const byCluster = new Map();
  for (const n of live) { if (!byCluster.has(n.sid)) byCluster.set(n.sid, []); byCluster.get(n.sid).push(n); }
  for (const n of live) {
    if (n.kind === "soma" || !n.parent) continue;
    const soma = S.byKey.get("s:" + n.sid); if (!soma) continue;
    let rest = n.kind === "phase" ? (n.index ? 0.55 : 0.85) : n.kind === "fold" ? 1.2 : n.parent.kind === "wf" ? 1.3 : (REST[n.kind] || 1.5) + soma.r;
    if (n.kind === "agent" && n.data && n.data.state === "done") rest *= 1.35;
    rest *= g * (soma.squeeze || 1);
    const d = TMP.subVectors(n.p, n.parent.p), dist = Math.max(0.01, d.length());
    d.multiplyScalar((6 * (dist - rest)) / dist); n.f.addScaledVector(d, -tau); n.parent.f.addScaledVector(d, tau * (n.parent.kind === "soma" ? 0.25 : 0.5));
    U.copy(soma.p).normalize(); n.f.addScaledVector(U, 0.9 * tau); // clusters open away from the A, like dandelion heads
    if (n.kind === "phase" && n.index >= 1 && n.parent.parent) { TMP2.subVectors(n.parent.p, n.parent.parent.p).normalize(); n.f.addScaledVector(TMP2, 0.6 * tau); } // a string of pearls
  }
  if (!S.substep) for (const nodes of byCluster.values()) for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j], d = TMP.subVectors(b.p, a.p), dist = Math.max(0.3, d.length());
    d.multiplyScalar(1.2 / (dist * dist) / dist); a.f.addScaledVector(d, -tau); b.f.addScaledVector(d, tau);
  }
  const damp = Math.exp(-5 * h);
  for (const n of live) {
    n.v.addScaledVector(n.f, h / n.mass).multiplyScalar(damp);
    const sp = n.v.length(); if (sp > 14) n.v.multiplyScalar(14 / sp);
    n.p.addScaledVector(n.v, h);
  }
  // Nothing touches: a positional pass on a spatial hash, twice; nothing inside the A's sphere.
  const C = 1.6;
  for (let it = 0; it < 2; it++) {
    const cells = new Map(), key = (x, y, z) => x + "," + y + "," + z;
    for (const n of live) { const k = key(Math.floor(n.p.x / C), Math.floor(n.p.y / C), Math.floor(n.p.z / C)); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(n); }
    for (const n of live) {
      const cx = Math.floor(n.p.x / C), cy = Math.floor(n.p.y / C), cz = Math.floor(n.p.z / C);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const cell = cells.get(key(cx + dx, cy + dy, cz + dz)); if (!cell) continue;
        for (const m of cell) {
          if (m === n || m.key < n.key) continue;
          const d = TMP.subVectors(m.p, n.p), dist = d.length(), min = n.r + m.r + 0.2;
          if (dist >= min) continue;
          if (dist < 1e-4) d.set(hash(n.key) - 0.5, hash(m.key) - 0.5, 0.1);
          d.normalize().multiplyScalar(min - dist);
          n.p.addScaledVector(d, -m.mass / (n.mass + m.mass)); m.p.addScaledVector(d, n.mass / (n.mass + m.mass));
        }
      }
    }
  }
  for (const n of live) { const min = n.kind === "soma" ? 7.6 + n.r : CORE, l = n.p.length(); if (l < min) n.p.multiplyScalar(min / Math.max(l, 0.001)); }
}

// ── each frame ──
const C = new THREE.Color(), C2 = new THREE.Color(), M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(), E = new THREE.Euler(), ORIGIN = new THREE.Vector3();
function frame(nowMs) {
  if (!S || !S.running) { if (S) S.raf = 0; return; }
  S.raf = requestAnimationFrame(frame);
  const raw = Math.min(0.05, (nowMs - S.last) / 1000), mo = motion(), dt = raw * mo; S.last = nowMs; S.t += dt; S.time.value = S.t;
  const t = S.t;
  // Adaptive quality, by what a frame costs (its own work, not the display's rate): the pixel ratio down, then bloom
  // off, after 2 s of heavy frames; back up after 6 s of light ones. Not in the first 2 s, while shaders compile.
  if (S.t > 2 && S.workEma !== undefined) {
    const heavy = S.workEma > 14, light = S.workEma < 6;
    S.heavyFor = heavy ? (S.heavyFor || 0) + raw : 0; S.lightFor = light ? (S.lightFor || 0) + raw : 0;
    if (S.heavyFor > 2 && S.quality < 3) { S.quality++; S.heavyFor = 0; resize(); }
    else if (S.lightFor > 6 && S.quality > 0) { S.quality--; S.lightFor = 0; resize(); }
  }
  S.bloom.enabled = S.quality < 3;
  const workStart = performance.now();
  // Shown states that have held.
  for (const n of S.nodes) if (n.kind === "soma" && !n.dying) { const st = S.sessions.get(n.sid); if (st && st.raw !== st.shown && nowMs - st.rawSince > 1200) setShown(n, st, st.raw, nowMs, true); }
  // Physics, until it sleeps.
  if (!S.asleep) {
    const steps = Math.min(3, Math.max(1, Math.round(raw * 60)));
    for (let k = 0; k < steps; k++) { S.substep = k > 0; step(1 / 60); }
    S.substep = false;
    S.tau = Math.max(0.04, S.tau * Math.pow(0.5, raw / 1.5));
    let ke = 0; for (const n of S.nodes) ke += n.v.lengthSq();
    S.quietFor = S.tau <= 0.041 && ke < 1e-3 * Math.max(1, S.nodes.length) ? S.quietFor + raw : 0;
    if (S.quietFor > 1) S.asleep = true;
  }
  // Every 15 frames: each cluster's reach, and a gentle squeeze on any grown too big.
  if ((S.frameN = (S.frameN || 0) + 1) % 15 === 0) for (const s of S.nodes) if (s.kind === "soma") {
    let rc = s.r; for (const n of S.nodes) if (n.sid === s.sid && n !== s && !n.dying) rc = Math.max(rc, n.p.distanceTo(s.p) + n.r);
    s.rc = rc; s.squeeze = rc > 6.5 ? 0.85 : rc < 5 ? 1 : s.squeeze || 1;
  }
  // The A: turning, its glow with the fleet's work, flaring as pulses land (green as a task lands).
  S.logo.rotation.y += 0.12 * dt;
  S.flare *= Math.exp(-raw / 0.4);
  const green = nowMs < (S.greenUntil || 0);
  S.aMat.emissive.set(green ? P.green : P.g2); S.aMat.emissiveIntensity = 0.3 + 0.25 * (S.fleetRate || 0) + S.flare * 0.9;
  S.aGlow.material.opacity = 0.18 + 0.5 * S.flare; S.aGlow.material.color.set(green ? P.green : P.g2);
  S.gauges.forEach((gm, i) => {
    const to = gm.userData.to; gm.visible = to >= 0;
    if (to < 0) return;
    gm.userData.pct = gm.userData.set ? spring(gm.userData.pct, to, 3, raw) : to; gm.userData.set = true;
    const pct = gm.userData.pct * 100, u = gm.material.uniforms;
    u.uPct.value = gm.userData.pct; u.uHot.value = pct >= 80 ? 2 : i === 0 && pct >= 60 ? 1 : 0;
    u.uPulse.value = i === 0 && pct >= 95 ? 0.75 + 0.25 * Math.sin(t * Math.PI * 2) : 1;
    gm.rotation.z += 0.05 * dt;
  });
  if (S.d) {
    // Output trickles out to each session writing it: the A feeding it.
    const live = S.pulses.filter((p) => p.trickle).length;
    const rates = (S.d.sessions || []).map((s) => { const o = sum(((s.timeline && s.timeline.out) || []).slice(-2)); return [s.sid, o > 0 ? 0.3 + 3 * (o / S.outMax) : 0]; });
    const total = sum(rates.map((r) => r[1])), cap = mo < 1 ? 20 : 90, scale = total ? Math.max(0, Math.min(1, (cap - live) / Math.max(1, total * 1.2))) : 0;
    for (const [sid, rate] of rates) { const n = S.byKey.get("s:" + sid); if (!n || n.dying || rate <= 0) continue; const acc = (S.trickleAcc.get(sid) || 0) + rate * scale * dt; if (acc >= 1) { trickle(n); S.trickleAcc.set(sid, acc - 1); } else S.trickleAcc.set(sid, acc); }
    // The four sessions that have waited longest call the A in amber, and ripple.
    for (const [sid] of [...S.needsSince.entries()].sort((a, b) => a[1] - b[1]).slice(0, 4)) {
      const n = S.byKey.get("s:" + sid); if (!n) continue;
      if (nowMs - (S.callAt.get(sid) || 0) > 1600) { S.callAt.set(sid, nowMs); pulseUp(n, P.amber, 0.5, 6, 0); }
      if (mo === 1 && nowMs - (S.callAt.get(sid + ":r") || 0) > 2200) { S.callAt.set(sid + ":r", nowMs); ring(n.p, P.amber, n.r, n.r + 2.6, 1400, n); }
    }
  }
  cameraFrame(raw, nowMs);
  draw(nowMs, t, raw);
  S.composer.render();
  labelsFrame(nowMs);
  const work = performance.now() - workStart;
  S.workEma = S.workEma === undefined ? work : S.workEma * 0.9 + work * 0.1;
}

// The camera: orbiting a pivot (the origin, or the cluster in focus), fitted so every node is on the screen.
function cameraFrame(raw, nowMs) {
  const { camera, view } = S, idle = nowMs - view.idleSince > 8000 && !S.focus && motion() === 1 && !view.dragging;
  if (idle) view.theta += 0.035 * raw;
  if (Math.abs(view.dragV) > 1e-4) { view.theta += view.dragV * raw; view.dragV *= Math.exp(-4 * raw); }
  const phi0 = camera.aspect < 0.8 ? 1.25 : 1.15;
  view.phi = spring(view.phi, view.userPhi ?? phi0 + (idle ? 0.07 * Math.sin((nowMs / 40000) * Math.PI * 2) : 0), 3, raw);
  if (S.focus) { const c = TMP.set(0, 0, 0); let k = 0; for (const n of S.nodes) if (n.sid === S.focus.sid && !n.dying) { c.add(n.p); k++; } if (k) view.pivotTo.copy(c.divideScalar(k)); }
  else view.pivotTo.set(0, 0, 0);
  if (nowMs - S.fitAt > 250 || !view.framed) {
    S.fitAt = nowMs;
    const halfV = THREE.MathUtils.degToRad(camera.fov / 2), halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const fwd = new THREE.Vector3(Math.sin(view.phi) * Math.cos(view.theta), Math.cos(view.phi), Math.sin(view.phi) * Math.sin(view.theta));
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).normalize(), up = new THREE.Vector3().crossVectors(fwd, right);
    let fit = 22;
    const pts = S.nodes.filter((n) => !n.dying && (!S.focus || n.sid === S.focus.sid));
    for (const n of pts) { const q = V.subVectors(n.p, view.pivotTo), x = Math.abs(q.dot(right)) + n.r, y = Math.abs(q.dot(up)) + n.r; fit = Math.max(fit, Math.max(x / Math.tan(halfH), y / Math.tan(halfV)) + q.dot(fwd)); }
    if (!S.focus) fit = Math.max(fit, 6.6 / Math.tan(Math.min(halfH, halfV)) + 6.6); // the gauges
    view.fit = 1.04 * fit + 1;
  }
  const target = view.fit * view.zoom;
  view.r = !view.framed || S.t < 2 ? target : spring(view.r, target, target > view.r ? 2 : 0.6, raw);
  if (S.d) view.framed = true;
  view.pivot.lerp(view.pivotTo, 1 - Math.exp(-4 * raw));
  camera.position.set(view.pivot.x + view.r * Math.sin(view.phi) * Math.cos(view.theta), view.pivot.y + view.r * Math.cos(view.phi), view.pivot.z + view.r * Math.sin(view.phi) * Math.sin(view.theta));
  camera.lookAt(view.pivot); camera.updateMatrixWorld();
  const ext = Math.max(14, view.fit * 0.45);
  S.fog.near.value = view.r - 0.3 * ext; S.fog.far.value = view.r + 1.6 * ext;
}

// The lit set: a node, its line up to the soma, the soma's axon, and everything under it (and its workflow's phases).
function litSet(n) {
  if (!n || n.kind === "A") return null;
  const lit = new Set(), under = (m) => { for (const k of S.nodes) if (k.parent === m && !lit.has(k)) { lit.add(k); under(k); } };
  for (let m = n; m; m = m.parent) lit.add(m);
  under(n);
  if (n.wf) { const wf = S.byKey.get(n.wf); if (wf) { lit.add(wf); under(wf); } }
  return lit;
}

function draw(nowMs, t, raw) {
  const camQ = S.camera.quaternion, mo = motion();
  const lit = (S.lit = S.filter ? new Set(S.nodes.filter((n) => n.kind === "soma" && S.sessions.get(n.sid) && S.sessions.get(n.sid).shown === S.filter)) : litSet(S.focus || S.hover));
  const counts = { soma: 0, wf: 0, phase: 0, agent: 0, task: 0 }, rib = S.ribbon.geometry.attributes;
  let ne = 0, nc = 0, ncx = 0;
  for (const s of S.sessions.values()) s.children = 0;
  for (const n of S.nodes) if (n.kind !== "soma" && !n.dying) { const s = S.sessions.get(n.sid); if (s) s.children++; }
  // The dead go once they have shrunk away.
  S.nodes = S.nodes.filter((n) => {
    if (!(n.dying && nowMs - n.dying > (n.kind === "soma" ? 900 : 450))) return true;
    S.byKey.delete(n.key);
    if (n.kind === "soma") { S.sessions.delete(n.sid); S.needsSince.delete(n.sid); }
    if (S.hover === n) setHover(null);
    if (S.focus === n || (n.kind === "soma" && S.focus && S.focus.sid === n.sid)) unfocus();
    return false;
  });
  for (const n of S.nodes) {
    const st = S.sessions.get(n.sid), shown = st ? st.shown : "working", d = n.data || {};
    // Bloom and birth: out from the parent's shown place to its own, springing past and back. Dying: back in.
    const fresh = n.born > S.bloomStart, u = THREE.MathUtils.clamp((nowMs - (fresh ? n.born : S.bloomStart) - (fresh ? 0 : n.delay)) / (fresh ? 900 : 700), 0, 1);
    let grow = mo < 1 ? u : easeOutBack(u);
    if (n.dying) grow = Math.max(0, 1 - (nowMs - n.dying) / (n.kind === "soma" ? 900 : 450));
    n.disp.copy(n.parent ? n.parent.disp : ORIGIN).lerp(n.p, Math.min(1.2, grow));
    if (n.kind === "soma") n.disp.y += 0.08 * Math.sin(t * 0.44 + hash(n.key) * 6.28); // an ambient bob
    // Its look, by kind.
    let r = 0.2, glow = 0.5, kind = n.kind, spin = 0;
    n.jit = 0;
    if (kind === "soma") {
      n.colTo.set(STATE_COLOUR[shown] || P.dim); glow = STATE_GLOW[shown] ?? 0.5;
      n.r = spring(n.r, THREE.MathUtils.clamp(0.65 + 0.1 * Math.sqrt(st ? st.children : 0) + 0.45 * Math.sqrt(st ? st.share : 0), 0.65, 1.5), 2, raw);
      r = n.r;
      if (shown === "needs") { const ph = t % 1.1; r *= 1 + 0.06 * (Math.exp(-ph * 30) + (ph > 0.18 ? Math.exp(-(ph - 0.18) * 30) : 0)); } // lub-dub
      else if (shown === "working" || shown === "yourTurn") r *= 1 + 0.05 * Math.sin(Math.PI * 2 * (0.3 + (st ? st.rate : 0)) * t);
    } else if (kind === "main" || kind === "agent" || kind === "fold") {
      if (kind === "fold") { n.colTo.set("#2b4a52"); glow = 0.2; r = 0.24 * (1 + 0.25 * Math.log2(1 + (d.n || 0) + (d.more || 0))); }
      else {
        const s2 = d.state || "quiet";
        n.colTo.set(kind === "main" ? (s2 === "stalled" ? P.red : P.spark) : AGENT_COLOUR[s2] || P.dim);
        glow = kind === "main" ? (s2 === "quiet" ? 0.4 : 1.2) : AGENT_GLOW[s2] ?? 0.5;
        r = kind === "main" ? 0.36 : AGENT_R[s2] ?? 0.2;
        if (s2 === "stalled") n.jit = 0.04 * Math.sin(t * 25 + hash(n.key) * 9);
      }
      kind = "agent";
    } else if (kind === "wf") {
      const running = d.outcome === "running";
      if (running) brand(1 - (d.done || 0) / Math.max(1, d.total || 1), n.colTo); else n.colTo.set(d.outcome === "failed" ? P.red : P.done);
      glow = running ? 0.8 : d.outcome === "failed" ? 0.9 : 0.3; r = running ? 0.55 : 0.41;
      n.spinA = (n.spinA || 0) + raw * mo * (running ? ((d.phases || []).some((p) => p.state === "now") ? 0.6 : 0.15) : d.outcome === "failed" ? 0.05 * Math.sin(t * 3) : 0);
      spin = n.spinA;
    } else if (kind === "phase") {
      n.colTo.set(d.state === "done" ? P.violet : d.state === "now" ? P.spark : "#1b2433");
      if (d.state === "done") n.colTo.multiplyScalar(0.7);
      glow = d.state === "now" ? 1.6 * (0.85 + 0.15 * Math.sin(Math.PI * 2 * 1.6 * t)) : d.state === "done" ? 0.5 : 0; r = 0.17;
    } else if (kind === "task" || kind === "tdone") {
      if (kind === "tdone") { n.colTo.set(P.done); glow = 0.2 + 0.8 * (d.done / Math.max(1, d.total)); n.pop = Math.max(0, (n.pop || 0) - raw * 3); r = 0.26 * (1 + 0.12 * Math.sqrt(d.done)) * (1 + 0.25 * n.pop); }
      else if (d.blocked) { n.colTo.set(P.red); glow = 0.9 * (0.7 + 0.3 * Math.sin(t * Math.PI * 4)); r = 0.22; }
      else if (d.status === "in_progress") { n.colTo.set(P.green); glow = 0.8 * (0.85 + 0.15 * Math.sin(t * Math.PI)); r = 0.22; }
      else { n.colTo.set(P.dim); glow = 0.15; r = 0.22; }
      kind = "task";
    }
    if (n.kind !== "soma") n.r = r;
    n.col.lerp(n.colTo, 1 - Math.exp(-raw / 0.2));
    n.flash = Math.max(0, n.flash - raw / 0.14);
    n.dimTo = lit ? (lit.has(n) ? 1 : 0.18) : 1;
    n.dim = spring(n.dim, n.dimTo, 14, raw);
    const m = S.mesh[kind], i = counts[kind];
    if (!m || i >= MAX[kind]) continue;
    const sc = r * Math.max(0, grow);
    E.set(kind === "task" ? Math.PI / 4 : 0, spin, kind === "task" ? Math.PI / 4 : 0); Q.setFromEuler(E);
    V.copy(n.disp); V.x += n.jit;
    M4.compose(V, Q, SC.set(sc, sc, sc)); m.setMatrixAt(i, M4);
    const a = m.geometry.attributes; a.aColor.setXYZ(i, n.col.r, n.col.g, n.col.b); a.aGlow.setX(i, glow + 2 * n.flash); a.aDim.setX(i, n.dim);
    counts[kind]++;
    // A soma's corona, and its context ring facing the camera.
    if (n.kind === "soma") {
      const beat = shown === "needs" ? 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.1) : 0, faint = shown === "idle" || shown === "finished";
      setPoint(S.corona, nc++, n.disp, n.col, 4.2 * r * Math.max(0, grow) * (1 + 0.25 * beat), (faint ? 0.12 : 0.3 + 0.55 * beat) * (0.3 + 0.7 * n.dim));
      const ctx = d.ctx;
      if (ctx) {
        const ca = S.ctx.geometry.attributes, split = (ctx.split || []).filter((p) => p.tokens > 0), total = sum(split.map((p) => p.tokens)) || 1;
        const parts = split.length ? split.slice(0, 3).concat(split.length > 3 ? [{ tokens: sum(split.slice(3).map((p) => p.tokens)), color: split[3].color }] : []) : [{ tokens: 1, color: P.white }];
        const ends = [1, 1, 1, 1]; let acc = 0;
        parts.forEach((p, k) => { acc += (p.tokens / total) * (ctx.pct / 100); ends[k] = acc; });
        const hot = ctx.pct >= 90 && ctx.runway && nowMs % 3000 < 150;
        ca.aPct.setX(ncx, ctx.pct / 100); ca.aEnds.setXYZW(ncx, ends[0], ends[1], ends[2], ends[3]); ca.aDim.setX(ncx, n.dim);
        for (let k = 0; k < 4; k++) { C.set(parts[Math.min(k, parts.length - 1)].color); if (ctx.pct >= 85 || hot) C.lerp(C2.set(P.red), hot ? 1 : 0.35); ca["aC" + k].setXYZ(ncx, C.r, C.g, C.b); }
        M4.compose(n.disp, camQ, SC.setScalar((r + 0.42) * Math.max(0, grow))); S.ctx.setMatrixAt(ncx, M4); ncx++;
      }
    }
    if (ne < MAX.edges) ne = edgeOf(n, rib, ne, shown, lit, t, grow);
  }
  for (const k of Object.keys(S.mesh)) { const m = S.mesh[k]; m.count = counts[k]; m.instanceMatrix.needsUpdate = true; for (const a of ["aColor", "aGlow", "aDim"]) m.geometry.attributes[a].needsUpdate = true; }
  S.ctx.count = ncx; S.ctx.instanceMatrix.needsUpdate = true; for (const a of ["aPct", "aEnds", "aC0", "aC1", "aC2", "aC3", "aDim"]) S.ctx.geometry.attributes[a].needsUpdate = true;
  flushPoints(S.corona, nc);
  S.ribbon.geometry.setDrawRange(0, ne * 60);
  for (const k of ["position", "aOther", "aSide", "aColor", "aAlpha", "aWidth"]) rib[k].needsUpdate = true;
  drawPulses(nowMs, raw, lit);
  drawRings(nowMs);
}

// A node's edge as a quadratic curve: from its parent's surface (or 3.2 out from the A, for a soma's axon) to its own,
// bowed to one side by a set amount from the edge's key, so it never shimmers as the camera turns.
const P0 = new THREE.Vector3(), P1 = new THREE.Vector3(), P2 = new THREE.Vector3(), N1 = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), XA = new THREE.Vector3(1, 0, 0);
function curveOf(n) {
  const axon = n.kind === "soma" || !n.parent;
  if (axon) P0.copy(n.disp).normalize().multiplyScalar(3.2); else P0.copy(n.parent.disp);
  P2.copy(n.disp);
  const dir = TMP2.subVectors(P2, P0), L = Math.max(0.01, dir.length()); dir.divideScalar(L);
  if (!axon) P0.addScaledVector(dir, n.parent.r);
  P2.addScaledVector(dir, -n.r);
  N1.crossVectors(dir, Math.abs(dir.dot(UP)) > 0.95 ? XA : UP).normalize().multiplyScalar((hash(n.key) > 0.5 ? 1 : -1) * (axon ? 0.12 : 0.16) * L);
  P1.addVectors(P0, P2).multiplyScalar(0.5).add(N1);
  return L;
}
const bez = (t, out) => out.set(0, 0, 0).addScaledVector(P0, (1 - t) * (1 - t)).addScaledVector(P1, 2 * (1 - t) * t).addScaledVector(P2, t * t);
const BP = new THREE.Vector3(), BQ = new THREE.Vector3(), CA = new THREE.Color(), CB = new THREE.Color();
function edgeOf(n, rib, ne, shown, lit, t, grow) {
  if (n.kind !== "soma" && !n.parent) return ne;
  n.edgeLen = curveOf(n);
  const st = S.sessions.get(n.sid), share = st ? st.share : 0, d = n.data || {};
  let width = 0.05, alpha = 0.75, flick = 0;
  if (n.kind === "soma") {
    CA.copy(GRAD[0]); CB.copy(n.col); width = 0.1 + 0.16 * share;
    alpha = shown === "idle" ? 0.25 : shown === "finished" ? 0.15 : 0.5 + 0.5 * share;
    flick = shown === "needs" ? 1 : shown === "stalled" ? 2 : 0;
  } else {
    CA.copy(n.parent.col); CB.copy(n.col);
    if (n.kind === "wf") { width = 0.08; alpha = 0.85; }
    else if (n.kind === "phase") { width = 0.045; CA.set(P.violet); CB.set(P.white); alpha = d.state === "next" ? 0.3 : 0.9; }
    else if (n.kind === "task") { width = 0.035; alpha = d.blocked ? 0.9 : 0.6; CA.copy(n.col); }
    else if (n.kind === "tdone") { width = 0.035; CA.set(P.green); CB.set(P.green); alpha = 0.5; }
    else alpha = d.state === "done" || n.kind === "fold" ? 0.25 : 0.75;
  }
  alpha *= Math.max(0, Math.min(1, grow)) * (0.12 + 0.88 * n.dim) * (lit && lit.has(n) ? 2 : 1);
  const base = ne * 22;
  for (let k = 0; k <= 10; k++) {
    const tt = k / 10; bez(tt, BP);
    if (k === 10) { bez(0.9, BQ); BQ.subVectors(BP, BQ).add(BP); } else bez(tt + 0.1, BQ);
    let a = alpha;
    if (flick === 1) a *= 0.6 + 0.4 * Math.sin(9 * tt - 6 * t);
    else if (flick === 2) a *= 0.6 + 0.4 * Math.sin(t * 19 + tt * 3 + Math.sin(t * 7));
    C.copy(CA).lerp(CB, n.kind === "soma" ? Math.max(0, (tt - 0.5) / 0.5) : tt);
    if (n.kind === "soma" && tt < 0.5) C.lerp(GRAD[1], Math.sin(tt * Math.PI) * 0.6);
    for (let s = 0; s < 2; s++) {
      const v = base + k * 2 + s;
      rib.position.setXYZ(v, BP.x, BP.y, BP.z); rib.aOther.setXYZ(v, BQ.x, BQ.y, BQ.z); rib.aSide.setX(v, s ? 1 : -1);
      rib.aColor.setXYZ(v, C.r, C.g, C.b); rib.aAlpha.setX(v, a); rib.aWidth.setX(v, width);
    }
  }
  return ne + 1;
}

function drawPulses(nowMs, raw, lit) {
  let np = 0;
  const mo = motion();
  S.pulses = S.pulses.filter((p) => {
    if (nowMs < p.at) return true;
    let n = p.route[p.i];
    if (!n || (n.dying && nowMs - n.dying > 300)) return false;
    const sp = p.stutter ? (Math.floor(nowMs / 150) % 2 ? 8 : 2) : p.speed;
    p.t += (p.dir * sp * raw * mo) / (n.edgeLen || 3);
    if ((p.dir < 0 && p.t <= 0) || (p.dir > 0 && p.t >= 1)) {
      p.i++;
      if (p.i >= p.route.length) { if (p.land) S.flare = Math.min(1, S.flare + (p.col.g > 0.5 && p.col.r < 0.4 ? 0.15 : 0.06)); return false; }
      p.t = p.dir < 0 ? 1 : 0; n = p.route[p.i];
    }
    curveOf(n);
    const on = !lit || lit.has(n), size = p.size * (on && lit ? 1.4 : 1), a = on ? 1 : 0.25;
    for (let k = 0; k < 3 && np < MAX.pulses * 3; k++) setPoint(S.pulseMesh, np++, bez(THREE.MathUtils.clamp(p.t - p.dir * 0.025 * k, 0, 1), BP), p.col, size * [1, 0.65, 0.4][k], a * [1, 0.5, 0.25][k]);
    return true;
  });
  flushPoints(S.pulseMesh, np);
}
function drawRings(nowMs) {
  let nr = 0;
  S.rings = S.rings.filter((r) => {
    const u = (nowMs - r.t0) / r.dur; if (u >= 1) return false;
    setPoint(S.ringMesh, nr++, r.follow ? r.follow.disp : r.at, r.col, 2 * (r.r0 + (r.r1 - r.r0) * u), 1 - u);
    return true;
  });
  flushPoints(S.ringMesh, nr);
}

// ── input: turning, zoom, hover, focus, keys ──
function wireInput() {
  const el = S.renderer.domElement, box = S.box, view = S.view, pointers = new Map();
  let down = null, pinch = 0, lastTap = { key: null, at: 0 };
  const interact = () => { view.idleSince = performance.now(); S.help.style.opacity = "0"; };
  el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); down = [e.clientX, e.clientY, performance.now()]; view.dragging = true; view.dragV = 0; interact(); });
  el.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === "touch") return;
      S.pointer = [e.clientX, e.clientY];
      if (!S.pickQueued) { S.pickQueued = true; requestAnimationFrame(() => { if (!S) return; S.pickQueued = false; setHover(pick(S.pointer), S.pointer); }); }
      return;
    }
    const [x0, y0] = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) view.zoom = THREE.MathUtils.clamp(view.zoom * (pinch / d), 0.35, 2.5); pinch = d; return; }
    const dx = e.clientX - x0; view.theta -= dx * 0.006; view.dragV = (-dx * 0.006) / 0.016;
    view.userPhi = THREE.MathUtils.clamp((view.userPhi ?? view.phi) - (e.clientY - y0) * 0.005, 0.3, 2.85);
    interact();
  });
  const up = (e) => {
    pointers.delete(e.pointerId); pinch = 0;
    if (!pointers.size) view.dragging = false;
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6 && performance.now() - down[2] < 400) {
      view.dragV = 0;
      const hit = pick([e.clientX, e.clientY], e.pointerType === "touch");
      if (e.pointerType === "touch") {
        // Touch: the first tap shows, a second on the same node acts.
        if (!hit) { setHover(null); unfocus(); }
        else if (lastTap.key === hit.key && performance.now() - lastTap.at < 4000) act(hit);
        else { setHover(hit, [e.clientX, e.clientY]); lastTap = { key: hit.key, at: performance.now() }; }
      } else act(hit);
    }
    down = null;
  };
  el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  el.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") setHover(null); });
  el.addEventListener("dblclick", (e) => { const hit = pick([e.clientX, e.clientY]); if (hit && hit.kind === "A") { S.bloomStart = performance.now(); for (const n of S.nodes) n.delay = 35 * n.depth + 12 * rankOf(n); } });
  el.addEventListener("wheel", (e) => { e.preventDefault(); view.zoom = THREE.MathUtils.clamp(view.zoom * Math.exp(e.deltaY * 0.001), 0.35, 2.5); interact(); }, { passive: false });
  S.onKey = (e) => {
    if (!S || document.activeElement !== box) return;
    if (e.key === "Escape") { S.filter = null; S.legendPinned = null; S.legendKey = null; unfocus(); renderLegend((S.d && S.d.sessions) || []); }
    else if (e.key === "Enter" && S.focus) S.hooks.open(S.focus.sid);
    else if (e.key === "Tab") {
      const somas = S.nodes.filter((n) => n.kind === "soma" && !n.dying).sort((a, b) => STATE_ORDER.indexOf(S.sessions.get(a.sid).shown) - STATE_ORDER.indexOf(S.sessions.get(b.sid).shown) || (S.needsSince.get(a.sid) || 0) - (S.needsSince.get(b.sid) || 0));
      const i = S.focus ? somas.findIndex((n) => n.sid === S.focus.sid) : -1, next = i + (e.shiftKey ? -1 : 1);
      if (!somas.length || next < 0 || next >= somas.length) { unfocus(); return; } // past either end: Tab moves on out of the scene
      e.preventDefault();
      focusOn(somas[next]);
    }
  };
  document.addEventListener("keydown", S.onKey);
}
function act(hit) {
  if (!hit || hit.kind === "A") { unfocus(); if (!hit) setHover(null); return; }
  if (hit.kind === "soma") { S.hooks.open(hit.sid); return; }
  focusOn(hit);
}
function focusOn(n) { S.focus = n; S.view.idleSince = performance.now(); renderPin(); }
function unfocus() { S.focus = null; S.pin.hidden = true; }

// What is under the pointer: each node's centre on the screen, the nearest within its own size (somas favoured).
const PR = new THREE.Vector3();
function project(v) { PR.copy(v).project(S.camera); return [(PR.x * 0.5 + 0.5) * S.box.clientWidth, (-PR.y * 0.5 + 0.5) * S.box.clientHeight, PR.z]; }
const screenR = (n) => (n.r * S.pxScale.value) / Math.max(0.1, S.camera.position.distanceTo(n.disp)) / (S.renderer.getPixelRatio() || 1);
function pick(at, coarse) {
  const rect = S.box.getBoundingClientRect(), x = at[0] - rect.left, y = at[1] - rect.top;
  let best = null, score = Infinity;
  for (const n of S.nodes) {
    if (n.dying) continue;
    const [sx, sy, sz] = project(n.disp); if (sz > 1) continue;
    const pr = screenR(n), dist = Math.hypot(sx - x, sy - y);
    if (dist > (coarse ? Math.max(pr + 6, 22) : Math.max(pr + 6, 12))) continue;
    const s = dist - 0.3 * pr + (n.kind !== "soma" && dist > pr ? 4 : 0) + sz * 1e-3;
    if (s < score) { score = s; best = n; }
  }
  if (!best) { const [ax, ay] = project(ORIGIN); if (Math.abs(ax - x) < 30 && Math.abs(ay - y) < 30) return { kind: "A", key: "A" }; }
  return best;
}
function setHover(n, at) {
  S.hover = n && n.kind !== "A" ? n : null; S.hoverA = !!(n && n.kind === "A");
  S.renderer.domElement.style.cursor = n ? (n.kind === "soma" ? "pointer" : "default") : "";
  if (!n) { S.tip.hidden = true; S.tipKey = null; return; }
  if (S.tipKey !== n.key) { S.tipKey = n.key; cardFor(n, S.tip); }
  S.tip.hidden = false;
  if (at) { const r = S.box.getBoundingClientRect(); S.tip.style.left = THREE.MathUtils.clamp(at[0] - r.left + 14, 8, Math.max(8, r.width - S.tip.offsetWidth - 8)) + "px"; S.tip.style.top = THREE.MathUtils.clamp(at[1] - r.top + 14, 8, Math.max(8, r.height - S.tip.offsetHeight - 8)) + "px"; }
}

// ── cards and labels ──
const elt = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
function cardFor(n, box) {
  box.replaceChildren();
  const add = (t) => { if (t) box.append(elt("div", "", t)); };
  if (n.kind === "A") {
    const d = S.d || {}, lims = (d.account && d.account.limits) || [], b = d.burn;
    box.append(elt("b", "", "Answertree · the fleet"));
    for (const l of lims) add(l.label + " " + l.pct + "%" + (l.resets ? " · " + l.resets : ""));
    add(d.five && d.five.text);
    if (b && b.total) { add("Eating the 5 hours:"); for (const x of b.top.slice(0, 5)) add("  " + x.name + " " + Math.round((x.out / b.total) * 100) + "%"); if (b.others) add("  +" + b.others + " others"); }
    return;
  }
  const s = ((S.d && S.d.sessions) || []).find((x) => x.sid === n.sid) || {}, d = n.data || {};
  if (n.kind === "soma") {
    box.append(elt("b", "", s.name || "session"));
    add((s.glyph ? s.glyph + " " : "") + (s.word || "") + (s.time ? " · " + s.time : ""));
    add(s.sub && s.sub.text && s.sub.text.slice(0, 160));
    if (s.ctx) {
      add("ctx " + s.ctx.pct + "%" + (s.ctx.runway ? " · " + s.ctx.runway : ""));
      const bar = elt("div", "omini"), total = Math.max(1, sum((s.ctx.split || []).map((y) => y.tokens)));
      for (const p of (s.ctx.split || []).filter((x) => x.tokens > 0).slice(0, 4)) { const i = elt("i"); i.style.width = (p.tokens / total) * s.ctx.pct + "%"; i.style.background = p.color; bar.append(i); }
      box.append(bar);
    }
    if (s.tasks && s.tasks.total) add("tasks " + s.tasks.done + "/" + s.tasks.total);
    const st = S.sessions.get(n.sid); if (st && st.share > 0.005) add("eating " + Math.round(st.share * 100) + "% of the 5 hours");
    if (s.prs && s.prs.length) add(s.prs.length + " pull request" + (s.prs.length === 1 ? "" : "s"));
    if (s.fails) add("fails " + s.fails.n + " · " + s.fails.last);
  } else if (n.kind === "wf") {
    box.append(elt("b", "", "≡ " + d.name)); add(d.outcome);
    add((d.phases || []).map((p) => (p.state === "done" ? "✓ " : p.state === "now" ? "◐ " : "○ ") + p.name).join("  "));
    add((d.done || 0) + "/" + (d.total || 0) + " agents · " + (d.age || "") + (d.tokens ? " · " + d.tokens + " tokens" : ""));
  } else if (n.kind === "phase") { box.append(elt("b", "", d.name)); add(d.state === "now" ? "under way" : d.state === "done" ? "done" : "next"); }
  else if (n.kind === "agent" || n.kind === "main") { box.append(elt("b", "", d.label || "agent")); add(d.state); add([d.tool, d.doing].filter(Boolean).join(" · ")); add([d.model, d.ago].filter(Boolean).join(" · ")); }
  else if (n.kind === "fold") { box.append(elt("b", "", (d.n || 0) + " done")); if (d.more) add(d.more + " more not shown"); }
  else if (n.kind === "task") { box.append(elt("b", "", d.text)); add(d.blocked ? "blocked" : d.status === "in_progress" ? "under way" + (d.since ? " · " + d.since : "") : "to do"); }
  else if (n.kind === "tdone") { box.append(elt("b", "", "Tasks")); add(d.done + "/" + d.total + " done"); }
}
function renderPin() {
  const n = S.focus; if (!n) return;
  if (!S.pinBody) {
    S.pinBody = elt("div");
    S.pinGo = elt("button", "ogo", "Open ↗"); S.pinGo.type = "button";
    S.pinGo.addEventListener("click", () => { if (S.focus) S.hooks.open(S.focus.sid); });
    S.pin.append(S.pinBody, S.pinGo);
  }
  cardFor(S.byKey.get("s:" + n.sid) || n, S.pinBody);
  S.pin.hidden = false;
}
function renderLegend(list) {
  const counts = {}; for (const s of list) { const st = S.sessions.get(s.sid), k = st ? st.shown : s.state; counts[k] = (counts[k] || 0) + 1; }
  const states = STATE_ORDER.filter((k) => counts[k]);
  if (S.legendPinned && !states.includes(S.legendPinned)) S.legendPinned = null;
  if (S.filter && !states.includes(S.filter)) S.filter = S.legendPinned;
  const keyNow = states.map((k) => k + counts[k]).join() + "|" + S.legendPinned;
  if (keyNow === S.legendKey) return; S.legendKey = keyNow;
  if (!S.legendPinned) S.filter = null; // a rebuilt legend is not hovered
  S.legend.replaceChildren(...states.map((k) => {
    const b = elt("button", S.legendPinned === k ? "on" : ""); b.type = "button";
    const dot = elt("i"); dot.style.background = STATE_COLOUR[k]; b.append(dot, String(counts[k]), elt("span", "", STATE_WORD[k]));
    b.addEventListener("pointerenter", () => { if (!S.legendPinned) S.filter = k; });
    b.addEventListener("pointerleave", () => { if (!S.legendPinned) S.filter = null; });
    b.addEventListener("click", () => { S.legendPinned = S.legendPinned === k ? null : k; S.filter = S.legendPinned; S.legendKey = null; renderLegend(list); });
    return b;
  }));
}
// Labels placed one by one, clear of what is already placed (the A's box first).
function placer(w, h) {
  const placed = [];
  return {
    block(x, y, bw, bh) { placed.push([x - bw / 2, y - bh / 2, x + bw / 2, y + bh / 2]); },
    put(x, y, bw, bh) {
      for (const dy of [0, -(bh + 4), -2 * (bh + 4), bh + 18]) {
        const x0 = THREE.MathUtils.clamp(x - bw / 2, 4, Math.max(4, w - bw - 4)), y0 = THREE.MathUtils.clamp(y - bh - 8 + dy, 4, Math.max(4, h - bh - 4));
        if (!placed.some((p) => x0 < p[2] + 4 && x0 + bw > p[0] - 4 && y0 < p[3] + 3 && y0 + bh > p[1] - 3)) { placed.push([x0, y0, x0 + bw, y0 + bh]); return [x0, y0]; }
      }
      return null;
    },
  };
}
function labelsFrame(nowMs) {
  const w = S.box.clientWidth, h = S.box.clientHeight;
  const [ax, ay] = project(V.set(0, -6.8, 0));
  S.core.style.left = ax + "px"; S.core.style.top = ay + "px";
  if (nowMs - S.layoutAt <= 250) {
    // Between layouts, chips ride with their soma.
    for (const [sid, c] of S.chips) { const n = S.byKey.get("s:" + sid); if (n && c.x0 !== undefined) { const [x, y] = project(n.disp); c.el.style.transform = `translate(${(c.x0 + x - c.ax).toFixed(1)}px,${(c.y0 + y - c.ay).toFixed(1)}px)`; } }
    return;
  }
  S.layoutAt = nowMs;
  const pl = placer(w, h), [cx, cy] = project(ORIGIN);
  pl.block(cx, cy, 130, 130);
  // A chip on each session waiting on you, the longest first, four at most, then "+N waiting".
  const waiting = [...S.needsSince.entries()].sort((a, b) => a[1] - b[1]).map(([sid]) => sid).filter((sid) => S.byKey.get("s:" + sid));
  const shown = waiting.slice(0, 4), keep = new Set(shown);
  for (const [sid, c] of S.chips) if (!keep.has(sid)) { c.el.remove(); S.chips.delete(sid); }
  for (const sid of shown) {
    let c = S.chips.get(sid);
    const s = ((S.d && S.d.sessions) || []).find((x) => x.sid === sid), n = S.byKey.get("s:" + sid);
    if (!c) { const el = elt("div", "ochip"); el.addEventListener("click", () => S.hooks.open(sid)); S.labels.append(el); c = { el }; S.chips.set(sid, c); }
    const name = (s && s.name) || ""; c.el.textContent = "▲ " + (name.length > 18 ? name.slice(0, 17) + "…" : name);
    c.el.style.display = ""; // measured shown
    const [x, y, z] = project(n.disp), at = z < 1 ? pl.put(x, y - screenR(n), c.el.offsetWidth, c.el.offsetHeight) : null;
    c.el.style.display = at ? "" : "none";
    if (at) { c.x0 = at[0]; c.y0 = at[1]; c.ax = x; c.ay = y; c.el.style.transform = `translate(${at[0]}px,${at[1]}px)`; }
  }
  let more = S.labels.querySelector(".omore");
  if (waiting.length > 4) { if (!more) { more = elt("div", "ochip omore"); S.labels.append(more); } more.textContent = "+" + (waiting.length - 4) + " waiting"; more.style.transform = `translate(${cx + 70}px,${cy - 10}px)`; }
  else if (more) more.remove();
  // Tags on the cluster hovered or in focus: ten at most, what matters most first; kept by node between layouts.
  const tagged = S.focus || S.hover, keepTags = new Map();
  if (tagged) {
    const prio = (n) => { const d = n.data || {}; return d.state === "stalled" ? 0 : n.kind === "wf" ? 1 : d.state === "tool" ? 2 : d.state === "active" ? 3 : n.kind === "task" && d.status === "in_progress" ? 4 : n.kind === "main" ? 5 : 9; };
    for (const n of S.nodes.filter((m) => m.sid === tagged.sid && m.kind !== "soma" && !m.dying && prio(m) < 9).sort((a, b) => prio(a) - prio(b)).slice(0, 10)) {
      const d = n.data || {}, text = n.kind === "wf" ? d.name : n.kind === "task" ? (d.text || "").slice(0, 24) : n.kind === "main" ? "main" : d.label;
      let el = S.tags.get(n.key);
      if (!el) { el = elt("div", "otag"); S.labels.append(el); }
      if (el.textContent !== text) el.textContent = text;
      el.style.display = "";
      const [x, y, z] = project(n.disp), at = z < 1 ? pl.put(x, y - 6, el.offsetWidth, el.offsetHeight) : null;
      if (!at) { el.remove(); continue; }
      el.style.transform = `translate(${at[0]}px,${at[1]}px)`; keepTags.set(n.key, el);
    }
  }
  for (const [k, el] of S.tags) if (!keepTags.has(k)) el.remove();
  S.tags = keepTags;
  if (S.hoverA) cardFor({ kind: "A", key: "A" }, S.tip);
}

export const debugState = () => S; // for the test harness
