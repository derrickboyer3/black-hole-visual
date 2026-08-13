import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

import vertexShader from './shaders/blackhole.vert.glsl?raw';
import fragmentShader from './shaders/blackhole.frag.glsl?raw';

// All distances are in Schwarzschild radii: horizon = 1, photon sphere = 1.5,
// shadow edge = 2.598, ISCO = 3.

const params = {
  // disk geometry
  innerRadius: 4.6,
  outerRadius: 16.0,
  density: 1.6,
  brightness: 1.15,
  edgeInner: 0.18,
  edgeOuter: 0.5,
  thickness: 0.55,
  grazing: 0.45,

  // turbulence — the wisp exponent is what defines the look
  turbulence: 1.0,
  turbScale: 1.45,
  turbStretch: 0.95,
  turbSharp: 7.4,
  turbLacunarity: 2.5,
  turbPersistence: 0.8,
  turbCycle: 18.0,
  seamlessLoop: true,

  // colour
  tempPeak: 26000,
  tempOuter: 1900,
  tempFalloff: 5.22,
  stylisedColour: true,

  // relativity
  spin: -3.2,
  lensing: 1.0,
  beaming: 0.55,
  dopplerPower: 1.0,
  photonRing: 0.09,

  // sky
  stars: 1.0,
  nebula: 0.5,

  // render
  steps: 220,
  winding: 4.0, // multiples of pi a ray may wrap before we give up on it
  supersample: false,
  smaa: true,
  resolution: Math.min(window.devicePixelRatio || 1, 1.5),
  exposure: 1.0,
  bloomStrength: 0.5,
  bloomRadius: 0.35,
  bloomThreshold: 0.65,

  // scene
  fov: 55,
  autoOrbit: true,
  orbitSpeed: 0.28,
  paused: false,
};

// Anything omitted from a preset keeps its current value.
const PRESETS = {
  'Wispy ring': {
    camera: [0, 3.6, 26.0], fov: 55,
    innerRadius: 4.6, outerRadius: 16.0, density: 1.6, brightness: 1.15,
    edgeInner: 0.18, edgeOuter: 0.5, thickness: 0.55, grazing: 0.45,
    turbulence: 1.0, turbScale: 1.45, turbStretch: 0.95, turbSharp: 7.4,
    turbLacunarity: 2.5, turbPersistence: 0.8,
    tempPeak: 26000, tempOuter: 1900, tempFalloff: 5.22, stylisedColour: true,
    spin: -3.2, lensing: 1.0, beaming: 0.55, photonRing: 0.09,
    stars: 1.0, nebula: 0.5, exposure: 1.0,
    bloomStrength: 0.5, bloomRadius: 0.35, bloomThreshold: 0.65,
  },
  'Gargantua (Interstellar)': {
    camera: [0, 2.8, 27.0], fov: 50,
    innerRadius: 3.0, outerRadius: 14.0, density: 0.9, brightness: 0.72,
    edgeInner: 0.05, edgeOuter: 0.6, thickness: 0.3, grazing: 0.45,
    turbulence: 0.55, turbScale: 1.0, turbStretch: 2.0, turbSharp: 2.6,
    turbLacunarity: 2.2, turbPersistence: 0.65,
    tempPeak: 11000, tempOuter: 3000, tempFalloff: 1.1, stylisedColour: false,
    spin: -2.2, lensing: 1.0, beaming: 0.28, photonRing: 0.07,
    stars: 1.0, nebula: 0.5, exposure: 1.0,
    bloomStrength: 0.45, bloomRadius: 0.5, bloomThreshold: 0.75,
  },
  'Edge-on, hard beaming': {
    camera: [0, 0.9, 21.0], fov: 46,
    innerRadius: 3.4, outerRadius: 18.0, density: 1.7, brightness: 1.05,
    edgeInner: 0.14, edgeOuter: 0.45, thickness: 0.4, grazing: 0.6,
    turbulence: 1.0, turbScale: 1.7, turbStretch: 0.8, turbSharp: 6.2,
    turbLacunarity: 2.5, turbPersistence: 0.8,
    tempPeak: 30000, tempOuter: 1700, tempFalloff: 4.4, stylisedColour: true,
    spin: -4.0, lensing: 1.0, beaming: 1.0, photonRing: 0.12,
    stars: 1.0, nebula: 0.35, exposure: 0.95,
    bloomStrength: 0.55, bloomRadius: 0.3, bloomThreshold: 0.6,
  },
  'M87* (radio portrait)': {
    camera: [0, 30.0, 10.0], fov: 42,
    innerRadius: 3.6, outerRadius: 9.0, density: 1.1, brightness: 1.5,
    edgeInner: 0.25, edgeOuter: 0.55, thickness: 0.8, grazing: 0.3,
    turbulence: 0.8, turbScale: 1.4, turbStretch: 1.1, turbSharp: 3.4,
    turbLacunarity: 2.3, turbPersistence: 0.7,
    tempPeak: 7000, tempOuter: 1800, tempFalloff: 2.4, stylisedColour: true,
    spin: -3.0, lensing: 1.0, beaming: 0.85, photonRing: 0.2,
    stars: 0.7, nebula: 0.25, exposure: 1.15,
    bloomStrength: 0.55, bloomRadius: 0.45, bloomThreshold: 0.6,
  },
  'Lensing off (comparison)': {
    camera: [0, 3.6, 26.0], fov: 55,
    lensing: 0.0, beaming: 0.0, photonRing: 0.0,
  },
};

// --------------------------------------------------------------- renderer

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: true, // so the S key can grab the framebuffer
});
renderer.setPixelRatio(params.resolution);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// The black hole is a single full-screen pass, so the "scene" is one quad drawn
// with an ortho camera. A second, never-rendered perspective camera is what
// OrbitControls drives and what feeds the shader its rays.
const scene = new THREE.Scene();
const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const viewCamera = new THREE.PerspectiveCamera(params.fov, window.innerWidth / window.innerHeight, 0.1, 1000);
viewCamera.position.set(0, 3.6, 26.0);

const uniforms = {
  uResolution: { value: new THREE.Vector2() },
  uTime: { value: 0 },
  uCamMat: { value: new THREE.Matrix4() },
  uTanHalfFov: { value: 0 },
  uAspect: { value: 1 },

  uSteps: { value: 0 },
  uPhiMax: { value: 0 },
  uLensing: { value: 0 },
  uAA: { value: 1 },

  uRin: { value: 0 },
  uRout: { value: 0 },
  uDensity: { value: 0 },
  uBrightness: { value: 0 },
  uEdgeInner: { value: 0 },
  uEdgeOuter: { value: 0 },
  uThickness: { value: 0 },
  uGrazing: { value: 0 },

  uTurb: { value: 0 },
  uTurbScale: { value: 0 },
  uTurbStretch: { value: 0 },
  uTurbSharp: { value: 0 },
  uTurbLac: { value: 0 },
  uTurbPers: { value: 0 },
  uTurbCycle: { value: 0 },
  uLoop: { value: 1 },

  uTempPeak: { value: 0 },
  uTempOuter: { value: 0 },
  uTempFalloff: { value: 0 },
  uRamp: { value: 1 },

  uSpin: { value: 0 },
  uBeaming: { value: 0 },
  uDopplerPow: { value: 0 },
  uPhotonRing: { value: 0 },

  uStars: { value: 0 },
  uNebula: { value: 0 },
  uExposure: { value: 0 },
};

const material = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms,
  depthTest: false,
  depthWrite: false,
});

const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
quad.frustumCulled = false;
scene.add(quad);

// ------------------------------------------------------------- controls

const controls = new OrbitControls(viewCamera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.45;
controls.zoomSpeed = 0.7;
controls.minDistance = 2.2;
controls.maxDistance = 300;

// ---------------------------------------------------------- postprocessing

const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType })
);
composer.addPass(new RenderPass(scene, quadCamera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  params.bloomStrength,
  params.bloomRadius,
  params.bloomThreshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// SMAA runs last, on tonemapped sRGB, which is where it belongs. Disabling it
// promotes OutputPass to the screen automatically.
const smaaPass = new SMAAPass();
smaaPass.enabled = params.smaa;
composer.addPass(smaaPass);

// ------------------------------------------------------------------ resize

function resize() {
  // clamp to >= 1: a hidden or zero-height container would otherwise produce
  // an incomplete framebuffer
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);

  renderer.setPixelRatio(params.resolution);
  renderer.setSize(w, h);
  composer.setPixelRatio(params.resolution);
  composer.setSize(w, h); // forwards the scaled size to every pass

  viewCamera.aspect = w / h;
  viewCamera.updateProjectionMatrix();

  uniforms.uResolution.value.set(w * params.resolution, h * params.resolution);
  uniforms.uAspect.value = w / h;
}

window.addEventListener('resize', resize);

// --------------------------------------------------------------- syncing

function syncUniforms() {
  uniforms.uSteps.value = params.steps;
  uniforms.uPhiMax.value = params.winding * Math.PI;
  uniforms.uLensing.value = params.lensing;
  uniforms.uAA.value = params.supersample ? 2 : 1;

  uniforms.uRin.value = params.innerRadius;
  uniforms.uRout.value = Math.max(params.outerRadius, params.innerRadius + 0.5);
  uniforms.uDensity.value = params.density;
  uniforms.uBrightness.value = params.brightness;
  uniforms.uEdgeInner.value = params.edgeInner;
  uniforms.uEdgeOuter.value = params.edgeOuter;
  uniforms.uThickness.value = params.thickness;
  uniforms.uGrazing.value = params.grazing;

  uniforms.uTurb.value = params.turbulence;
  uniforms.uTurbScale.value = params.turbScale;
  uniforms.uTurbStretch.value = params.turbStretch;
  uniforms.uTurbSharp.value = params.turbSharp;
  uniforms.uTurbLac.value = params.turbLacunarity;
  uniforms.uTurbPers.value = params.turbPersistence;
  uniforms.uTurbCycle.value = params.turbCycle;
  uniforms.uLoop.value = params.seamlessLoop ? 1 : 0;

  uniforms.uTempPeak.value = params.tempPeak;
  uniforms.uTempOuter.value = params.tempOuter;
  uniforms.uTempFalloff.value = params.tempFalloff;
  uniforms.uRamp.value = params.stylisedColour ? 1 : 0;

  uniforms.uSpin.value = params.spin;
  uniforms.uBeaming.value = params.beaming;
  uniforms.uDopplerPow.value = params.dopplerPower;
  uniforms.uPhotonRing.value = params.photonRing;

  uniforms.uStars.value = params.stars;
  uniforms.uNebula.value = params.nebula;
  uniforms.uExposure.value = params.exposure;

  bloomPass.strength = params.bloomStrength;
  bloomPass.radius = params.bloomRadius;
  bloomPass.threshold = params.bloomThreshold;
  smaaPass.enabled = params.smaa;

  controls.autoRotate = params.autoOrbit;
  controls.autoRotateSpeed = params.orbitSpeed;

  if (viewCamera.fov !== params.fov) {
    viewCamera.fov = params.fov;
    viewCamera.updateProjectionMatrix();
  }
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;

  for (const key of Object.keys(p)) {
    if (key !== 'camera' && key in params) params[key] = p[key];
  }

  if (p.camera) viewCamera.position.set(...p.camera);
  controls.target.set(0, 0, 0);
  controls.update();

  syncUniforms();
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

let pendingShot = false;
function saveCanvas() {
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `black-hole-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

// ------------------------------------------------------------------- gui

const state = { preset: 'Wispy ring' };

const gui = new GUI({ title: 'Black Hole', width: 300 });
gui.add(state, 'preset', Object.keys(PRESETS)).name('preset').onChange(applyPreset);

const fDisk = gui.addFolder('Disk');
fDisk.add(params, 'innerRadius', 1.5, 10, 0.05).name('inner radius (rs)');
fDisk.add(params, 'outerRadius', 4, 34, 0.1).name('outer radius (rs)');
fDisk.add(params, 'density', 0, 6, 0.01).name('opacity');
fDisk.add(params, 'brightness', 0, 10, 0.02).name('brightness');
fDisk.add(params, 'edgeInner', 0.01, 0.6, 0.01).name('inner edge softness');
fDisk.add(params, 'edgeOuter', 0.01, 0.95, 0.01).name('outer edge softness');
fDisk.add(params, 'thickness', 0.02, 2, 0.01).name('thickness');
fDisk.add(params, 'grazing', 0, 1, 0.01).name('grazing boost');

const fTurb = gui.addFolder('Turbulence');
fTurb.add(params, 'turbulence', 0, 1, 0.01).name('amount');
fTurb.add(params, 'turbSharp', 1, 16, 0.05).name('wisp sharpness');
fTurb.add(params, 'turbScale', 0.2, 6, 0.01).name('radial banding');
fTurb.add(params, 'turbStretch', 0.1, 4, 0.01).name('azimuthal stretch');
fTurb.add(params, 'turbLacunarity', 1.4, 4, 0.01).name('lacunarity');
fTurb.add(params, 'turbPersistence', 0.2, 1, 0.01).name('persistence');
fTurb.add(params, 'spin', -12, 12, 0.05).name('rotation speed');
fTurb.add(params, 'seamlessLoop').name('seamless loop');
fTurb.add(params, 'turbCycle', 2, 60, 0.5).name('loop length (s)');

const fColour = gui.addFolder('Colour');
fColour.add(params, 'tempPeak', 2000, 50000, 100).name('inner temp (K)');
fColour.add(params, 'tempOuter', 1000, 8000, 50).name('outer temp (K)');
fColour.add(params, 'tempFalloff', 0.3, 8, 0.02).name('temp falloff');
fColour.add(params, 'stylisedColour').name('stylised ramp');

const fRel = gui.addFolder('Relativity');
fRel.add(params, 'lensing', 0, 1, 0.01).name('light bending');
fRel.add(params, 'beaming', 0, 1, 0.01).name('doppler beaming');
fRel.add(params, 'dopplerPower', 0.2, 2, 0.01).name('beaming power');
fRel.add(params, 'photonRing', 0, 1, 0.01).name('photon ring');

const fSky = gui.addFolder('Sky');
fSky.add(params, 'stars', 0, 3, 0.01).name('stars');
fSky.add(params, 'nebula', 0, 3, 0.01).name('nebula');

const fCam = gui.addFolder('Camera');
fCam.add(params, 'fov', 20, 100, 1).name('field of view');
fCam.add(params, 'autoOrbit').name('auto orbit');
fCam.add(params, 'orbitSpeed', -2, 2, 0.01).name('orbit speed');
fCam.add(params, 'paused').name('freeze time');

const fRender = gui.addFolder('Quality');
fRender.add(params, 'steps', 60, 512, 1).name('ray steps');
fRender.add(params, 'winding', 1, 8, 0.1).name('max winding (pi)');
fRender.add(params, 'supersample').name('supersample 2x2');
fRender.add(params, 'smaa').name('SMAA');
fRender.add(params, 'resolution', 0.4, 2, 0.05).name('resolution scale').onChange(resize);
fRender.add(params, 'exposure', 0.1, 3, 0.01).name('exposure');
fRender.add(params, 'bloomStrength', 0, 3, 0.01).name('bloom strength');
fRender.add(params, 'bloomRadius', 0, 1, 0.01).name('bloom radius');
fRender.add(params, 'bloomThreshold', 0, 2, 0.01).name('bloom threshold');
fRender.close();

gui.add({ shot: () => { pendingShot = true; } }, 'shot').name('save PNG  (S)');

fTurb.close();
fColour.close();
fSky.close();

// --------------------------------------------------------------- keyboard

const overlay = document.getElementById('overlay');

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const refresh = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());

  switch (e.key.toLowerCase()) {
    case 'h':
      gui.domElement.classList.toggle('hidden');
      overlay.classList.toggle('hidden');
      break;
    case ' ':
      params.paused = !params.paused;
      refresh();
      e.preventDefault();
      break;
    case 's':
      pendingShot = true;
      break;
    case 'f':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.body.requestFullscreen?.();
      break;
    case 'o':
      params.autoOrbit = !params.autoOrbit;
      refresh();
      break;
  }
});

// ------------------------------------------------------------------ loop

const timer = new THREE.Timer();
timer.connect(document);

let simTime = 0;

const fpsEl = document.getElementById('fps');
let frames = 0;
let fpsAccum = 0;

function renderFrame(dt) {
  if (!params.paused) simTime += dt;

  controls.update();
  syncUniforms();

  viewCamera.updateMatrixWorld();
  uniforms.uCamMat.value.copy(viewCamera.matrixWorld);
  uniforms.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(viewCamera.fov) * 0.5);
  uniforms.uTime.value = simTime;

  composer.render();

  if (pendingShot) {
    pendingShot = false;
    saveCanvas();
  }
}

function animate() {
  requestAnimationFrame(animate);

  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);

  frames++;
  fpsAccum += dt;
  if (fpsAccum > 0.5) {
    fpsEl.textContent = `${Math.round(frames / fpsAccum)} fps`;
    frames = 0;
    fpsAccum = 0;
  }

  renderFrame(dt);
}

resize();
syncUniforms();
document.getElementById('loading')?.remove();
animate();

if (import.meta.env?.DEV) {
  // handle for poking at the scene from the console during development
  window.__bh = { THREE, renderer, composer, scene, viewCamera, controls, uniforms, params, PRESETS, applyPreset, resize, renderFrame };
}
