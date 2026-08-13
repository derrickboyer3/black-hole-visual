// ---------------------------------------------------------------------------
//  Schwarzschild black hole raymarcher
//
//  Everything is in units of the Schwarzschild radius, so rs = 1:
//     r = 1.0     event horizon
//     r = 1.5     photon sphere
//     b = 2.598   critical impact parameter, 3*sqrt(3)/2 -> edge of the shadow
//     r = 3.0     innermost stable circular orbit (ISCO)
//
//  Rays are traced backwards from the camera. A null geodesic stays in the
//  plane spanned by the camera position and the ray direction, so rather than
//  integrating a 4D geodesic we integrate the orbit inside that plane. With
//  u = 1/r it obeys the classic Binet-style equation
//
//     d^2u/dphi^2 = -u + (3/2) rs u^2
//
//  which is smooth and well behaved everywhere outside the horizon - a
//  fixed-step RK4 in phi is therefore both cheap and accurate. Drop the u^2
//  term and you get exact straight lines, which is what uLensing = 0 does.
//
//  The disk's *appearance* follows the WebGPU demo model: fbm banded in radius
//  and stretched in azimuth, raised to a high power so it breaks into sparse
//  wisps, over a steep blackbody-ish ramp.
// ---------------------------------------------------------------------------

varying vec2 vUv;

uniform vec2  uResolution;
uniform float uTime;
uniform mat4  uCamMat;      // camera world matrix
uniform float uTanHalfFov;
uniform float uAspect;

// integration
uniform float uSteps;
uniform float uPhiMax;
uniform float uLensing;     // 0 = flat space, 1 = full GR bending
uniform float uAA;          // 1 = one ray per pixel, 2 = 2x2 supersample

// disk geometry / opacity
uniform float uRin;
uniform float uRout;
uniform float uDensity;
uniform float uBrightness;
uniform float uEdgeInner;
uniform float uEdgeOuter;
uniform float uThickness;
uniform float uGrazing;     // 0 = flat sheet, 1 = full slab path-length boost

// disk turbulence
uniform float uTurb;        // overall amount, 0 = smooth ring
uniform float uTurbScale;   // radial banding frequency
uniform float uTurbStretch; // >1 stretches features along the flow
uniform float uTurbSharp;   // the wisp exponent - this is the look
uniform float uTurbLac;
uniform float uTurbPers;
uniform float uTurbCycle;   // seconds per seamless loop
uniform float uLoop;        // 1 = crossfade so the shear never turns to mush

// disk colour
uniform float uTempPeak;    // Kelvin at the inner edge
uniform float uTempOuter;   // Kelvin at the outer edge
uniform float uTempFalloff;
uniform float uRamp;        // 0 = physical Planck locus, 1 = stylised ramp

// relativity
uniform float uSpin;        // signed pattern rotation rate
uniform float uBeaming;     // 0 = none, 1 = full doppler + gravitational shift
uniform float uDopplerPow;
uniform float uPhotonRing;

// sky
uniform float uStars;
uniform float uNebula;

uniform float uExposure;

#define MAX_STEPS 512
#define PI 3.14159265359
#define B_CRIT 2.598076211353316   // 3*sqrt(3)/2

// camera frame, filled in by main()
vec3 gCamPos, gRight, gUp, gFwd;

// ------------------------------------------------------------------ hashing

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

vec3 hash33(vec3 p) {
  return vec3(
    hash31(p + vec3(0.0, 1.7, 3.1)),
    hash31(p + vec3(5.2, 0.3, 9.4)),
    hash31(p + vec3(7.8, 6.1, 0.6))
  );
}

// ------------------------------------------------------------------- noise

float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

float fbm3(vec3 p, float lac, float pers) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise3(p);
    p *= lac;
    a *= pers;
  }
  return s;
}

// ------------------------------------------------------------------ colour

// Physical Planck locus (after Neil Bartlett's rational fits), linear light.
// Used for the starfield, where accurate stellar colour is worth having.
vec3 kelvin(float T) {
  T = clamp(T, 1000.0, 40000.0);
  float t = T / 100.0;
  float r, g, b;

  if (t <= 66.0) {
    r = 255.0;
    g = 99.4708025861 * log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * pow(t - 60.0, -0.1332047592);
    g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
  }

  if (t >= 66.0) {
    b = 255.0;
  } else if (t <= 19.0) {
    b = 0.0;
  } else {
    b = 138.5177312231 * log(t - 10.0) - 305.0447927307;
  }

  return pow(clamp(vec3(r, g, b) / 255.0, 0.0, 1.0), vec3(2.2));
}

// Stylised disk ramp: deep red -> orange -> yellow -> white -> blue-white.
// Saturates around 10000K, so a very hot inner edge reads as blue-white while
// the outer disk falls away to ember red. Punchier and more saturated than a
// true Planck curve, at the cost of a green cast in the 7000-9000K band.
vec3 stylisedRamp(float T) {
  float t = clamp((T - 1000.0) / 9000.0, 0.0, 1.0);
  float r = clamp(1.0 - (t - 0.8) * 2.0, 0.5, 1.0);
  float g = smoothstep(0.0, 0.5, t) * (1.0 - max(t - 0.7, 0.0) * 0.3);
  float b = smoothstep(0.3, 1.0, t) * t;
  return vec3(r, g, b);
}

vec3 diskColour(float T) {
  if (uRamp > 0.5) return stylisedRamp(T);
  return kelvin(T);
}

// ------------------------------------------------------------------- sky

// One star per lattice cell, jittered inside it. A 3D lattice rather than a
// theta/phi grid, so there is no crowding at the poles.
vec3 starLayer(vec3 dir, float scale, float cut, float sharp, float gain) {
  vec3 p = dir * scale;
  vec3 id = floor(p + 0.5);
  vec3 rnd = hash33(id);
  if (rnd.x < cut) return vec3(0.0);

  vec3 center = id + (hash33(id + 11.3) - 0.5) * 0.62;
  float core = pow(max(0.0, 1.0 - length(p - center) * 2.2), sharp);

  vec3 tint = kelvin(mix(3200.0, 11000.0, rnd.y * rnd.y));
  float mag = mix(0.25, 1.0, rnd.z * rnd.z);

  return tint * core * mag * gain;
}

vec3 sky(vec3 dir) {
  // galactic plane, deliberately tilted away from the disk so the lensing
  // distortion of the band is easy to read
  vec3 bandAxis = normalize(vec3(0.34, 0.78, -0.52));
  float w = dot(dir, bandAxis);
  float band = exp(-w * w * 9.0);

  vec3 col = vec3(0.0);
  col += starLayer(dir, 55.0,  0.86, 9.0, 1.00);
  col += starLayer(dir, 130.0, 0.80, 7.0, 0.55);
  col += starLayer(dir, 290.0, 0.72, 5.0, 0.22);
  col += starLayer(dir, 200.0, 0.55, 6.0, 0.30) * band;   // crowding in the band
  col *= uStars;

  float n  = fbm3(dir * 2.3 + 4.7, 2.0, 0.5);
  float n2 = fbm3(dir * 6.1 - 2.1, 2.0, 0.5);
  vec3 dust = mix(vec3(0.024, 0.034, 0.075), vec3(0.092, 0.042, 0.108), n2);
  col += dust * n * (0.22 + band * 1.7) * uNebula;
  col += vec3(0.0020, 0.0028, 0.0055) * uNebula;          // never fully dead

  return col;
}

// ----------------------------------------------------------------- the disk

// photon travel direction (in the direction we are marching) at a given state
vec3 marchDir(float phi, float u, float du, vec3 e1, vec3 e2) {
  float r = 1.0 / max(u, 1e-9);
  vec3 rh = cos(phi) * e1 + sin(phi) * e2;
  vec3 th = -sin(phi) * e1 + cos(phi) * e2;
  float drdphi = -du / max(u * u, 1e-12);
  return normalize(drdphi * rh + r * th);
}

// Radiance of the disk where a ray crosses the equatorial plane. Opacity comes
// back through the out param.
vec3 diskShade(float r, vec3 pos, vec3 dir, out float alpha) {
  float rn = clamp((r - uRin) / max(uRout - uRin, 1e-3), 0.0, 1.0);
  float ang = atan(pos.z, pos.x);

  // ---- Keplerian shear. The pattern is sampled in a frame that winds with
  // omega ~ r^-3/2, so differential rotation drags the wisps into trailing
  // spirals on its own. Two samples a whole cycle apart are crossfaded, which
  // makes the animation loop exactly instead of shearing into mush forever.
  float cyc = max(uTurbCycle, 0.05);
  float tc = mod(uTime, cyc);
  float w = uSpin / pow(max(r, 0.5), 1.5);
  float st = max(uTurbStretch, 0.1);

  float a1 = ang + tc * w;
  vec3 q1 = vec3(r * uTurbScale, cos(a1) / st, sin(a1) / st);
  float turb = fbm3(q1, uTurbLac, uTurbPers);

  if (uLoop > 0.5) {
    float a2 = ang + (tc + cyc) * w;
    vec3 q2 = vec3(r * uTurbScale, cos(a2) / st, sin(a2) / st);
    turb = mix(fbm3(q2, uTurbLac, uTurbPers), turb, tc / cyc);
  }

  // the exponent is what turns a smooth cloud into sparse bright filaments
  float wisp = pow(clamp(turb, 0.0, 1.0), uTurbSharp);
  wisp = mix(1.0, wisp, clamp(uTurb, 0.0, 1.0));

  float edge = smoothstep(0.0, max(uEdgeInner, 1e-3), rn) *
               smoothstep(1.0, 1.0 - max(uEdgeOuter, 1e-3), rn);

  // ---- grazing rays cut a longer chord through the slab, so the disk thickens
  // and saturates when seen edge-on
  float ct = max(abs(dir.y), 0.02);
  float graze = pow(clamp(uThickness / ct, 1.0, 30.0), clamp(uGrazing, 0.0, 1.0));

  alpha = clamp(uDensity * wisp * edge * graze, 0.0, 1.0);

  // ---- relativistic shift.
  // uSpin < 0 advances the pattern towards +theta, i.e. along cross(rHat, yHat).
  vec3 nObs = -dir;                                     // emitter -> observer
  vec3 rh = normalize(vec3(pos.x, 0.0, pos.z));
  vec3 vh = normalize(cross(rh, vec3(0.0, 1.0, 0.0))) * -sign(uSpin);

  float beta = clamp(sqrt(0.5 / max(r, 1.0)), 0.0, 0.85);   // Keplerian, rs = 1
  float gamma = inversesqrt(1.0 - beta * beta);
  float doppler = 1.0 / (gamma * (1.0 - beta * dot(vh, nObs)));
  float grav = sqrt(max(0.04, 1.0 - 1.0 / max(r, 1.0001)));

  float g = clamp(mix(1.0, doppler * grav, clamp(uBeaming, 0.0, 1.0)), 0.1, 5.0);

  // I_nu / nu^3 is a relativistic invariant -> observed intensity goes as g^3
  float boost = pow(g, 3.0 * uDopplerPow);
  float T = mix(uTempOuter, uTempPeak, pow(uRin / r, uTempFalloff)) * g;

  return diskColour(T) * boost * uBrightness;
}

// --------------------------------------------------------------- the trace

vec3 traceRay(vec3 dir) {
  // ---- set up the orbital plane (gCamPos, dir)
  float r0 = length(gCamPos);
  vec3 e1 = gCamPos / r0;
  vec3 nrm = cross(e1, dir);
  float nl = length(nrm);
  if (nl < 1e-4) {
    // (near) radial ray: nudge it so the in-plane basis stays well defined
    dir = normalize(dir + gRight * 1.3e-3 + gUp * 7.0e-4);
    nrm = cross(e1, dir);
    nl = length(nrm);
  }
  nrm /= nl;
  // in-plane and along the ray, so dot(dir, e2) == nl > 0 and phi increases
  vec3 e2 = normalize(cross(nrm, e1));

  float u  = 1.0 / r0;
  float du = -u * dot(dir, e1) / nl;

  // Conserved along the geodesic: (du/dphi)^2 + u^2 - rs u^3 = 1/b^2, with b
  // the impact parameter. Used below to place the photon ring analytically.
  float bInv2 = du * du + u * u - uLensing * u * u * u;

  float phi = 0.0;
  float h = uPhiMax / max(uSteps, 1.0);
  float rEscape = max(r0 * 1.4, 55.0);

  float prevY   = gCamPos.y;
  float prevU   = u;
  float prevDu  = du;
  float prevPhi = 0.0;

  bool escaped = false;
  vec3 escDir = dir;

  vec3 acc = vec3(0.0);
  float trans = 1.0;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (float(i) >= uSteps) break;

    // ---- RK4 on (u, du) with u'' = -u + 1.5 * lensing * u^2
    float k1u = du;
    float k1d = -u + 1.5 * uLensing * u * u;

    float ua = u + 0.5 * h * k1u;
    float k2u = du + 0.5 * h * k1d;
    float k2d = -ua + 1.5 * uLensing * ua * ua;

    float ub = u + 0.5 * h * k2u;
    float k3u = du + 0.5 * h * k2d;
    float k3d = -ub + 1.5 * uLensing * ub * ub;

    float uc = u + h * k3u;
    float k4u = du + h * k3d;
    float k4d = -uc + 1.5 * uLensing * uc * uc;

    u  += (h / 6.0) * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
    du += (h / 6.0) * (k1d + 2.0 * k2d + 2.0 * k3d + k4d);
    phi += h;

    if (u <= 1e-7) {
      escaped = true;
      escDir = marchDir(prevPhi, prevU, prevDu, e1, e2);
      break;
    }

    float r = 1.0 / u;
    vec3 pos = r * (cos(phi) * e1 + sin(phi) * e2);

    // ---- disk: solved as an exact plane crossing, so it never aliases in y
    if (prevY * pos.y < 0.0) {
      float t = prevY / (prevY - pos.y);
      float phiH = mix(prevPhi, phi, t);
      float uH   = mix(prevU, u, t);
      float duH  = mix(prevDu, du, t);
      float rH   = 1.0 / max(uH, 1e-9);

      if (rH > uRin && rH < uRout) {
        vec3 dH = marchDir(phiH, uH, duH, e1, e2);
        vec3 posH = rH * (cos(phiH) * e1 + sin(phiH) * e2);
        float a;
        vec3 c = diskShade(rH, posH, dH, a);
        acc += trans * a * c;
        trans *= (1.0 - a);
      }
    }

    if (r <= 1.0) break;                       // through the horizon
    if (r > rEscape && du < 0.0) {
      escaped = true;
      escDir = marchDir(phi, u, du, e1, e2);
      break;
    }
    if (trans < 0.0025) break;                 // disk is already opaque

    prevY = pos.y; prevU = u; prevDu = du; prevPhi = phi;
  }

  // ---- background
  if (escaped) acc += trans * sky(escDir);

  // ---- photon ring.
  // Rays whose impact parameter sits at b = 3*sqrt(3)/2 orbit the hole an
  // unbounded number of times, so they carry an infinite series of ever
  // fainter disk images that no finite step budget can resolve. Add that
  // missing light back analytically: b is conserved, so the ring is exactly a
  // narrow band around the critical value, straddling the shadow's edge.
  if (uPhotonRing > 0.0 && uLensing > 0.0 && bInv2 > 1e-6) {
    float d = (inversesqrt(bInv2) - B_CRIT) / 0.055;
    acc += trans * exp(-d * d) * uPhotonRing * uLensing
         * diskColour(uTempPeak) * uBrightness;
  }

  return acc;
}

// ------------------------------------------------------------------- main

vec3 rayFor(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(
    gFwd +
    gRight * (ndc.x * uAspect * uTanHalfFov) +
    gUp    * (ndc.y * uTanHalfFov)
  );
}

void main() {
  gRight  =  uCamMat[0].xyz;
  gUp     =  uCamMat[1].xyz;
  gFwd    = -uCamMat[2].xyz;
  gCamPos =  uCamMat[3].xyz;

  vec3 col;

  if (uAA < 1.5) {
    col = traceRay(rayFor(vUv));
  } else {
    // rotated-grid 2x2: better edge gradients than an axis-aligned quad
    vec2 px = 1.0 / uResolution;
    col  = traceRay(rayFor(vUv + vec2(-0.375, -0.125) * px));
    col += traceRay(rayFor(vUv + vec2( 0.125, -0.375) * px));
    col += traceRay(rayFor(vUv + vec2( 0.375,  0.125) * px));
    col += traceRay(rayFor(vUv + vec2(-0.125,  0.375) * px));
    col *= 0.25;
  }

  gl_FragColor = vec4(col * uExposure, 1.0);
}
