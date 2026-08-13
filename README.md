# Black Hole

A real-time gravitationally lensed black hole in Three.js. The whole scene is one
full-screen fragment shader that traces light rays backwards through Schwarzschild
spacetime — the warped disk, the Einstein ring, the shadow and the lensed
starfield all fall out of the physics rather than being modelled by hand.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Controls

| | |
|---|---|
| drag | orbit |
| wheel | approach / retreat |
| `O` | toggle auto-orbit |
| `space` | freeze time |
| `S` | save a PNG |
| `F` | fullscreen |
| `H` | hide the UI |

The panel on the right has presets plus every parameter behind them.

## How it works

Distances are in Schwarzschild radii, so `rs = 1`:

| radius | |
|---|---|
| 1.0 | event horizon |
| 1.5 | photon sphere |
| 2.598 | critical impact parameter, `3√3/2` — the apparent edge of the shadow |
| 3.0 | innermost stable circular orbit (ISCO) |

**Ray tracing.** A null geodesic stays inside the plane spanned by the camera
position and the ray direction, so instead of integrating a 4D geodesic the
shader integrates the orbit *within* that plane. Writing `u = 1/r`, the path
obeys the classic Binet-style equation

```
d²u/dφ² = -u + (3/2) rs u²
```

which is smooth everywhere outside the horizon, so fixed-step RK4 in `φ` is both
cheap and accurate. Drop the `u²` term and you get exact straight lines — that is
what the **light bending** slider does, and the *Lensing off* preset is a useful
side-by-side.

**The disk** is found as an exact intersection with the equatorial plane rather
than by volume sampling, so it never aliases vertically no matter how thin it
gets. Rays can cross the plane several times, which is what produces the far side
of the disk arcing over the top of the shadow and the second, squashed image
underneath it. Each crossing composites front-to-back.

**Ring texture** comes from fbm sampled at `(r · scale, cos θ / stretch, sin θ / stretch)`
in a frame that co-rotates at the Keplerian rate `ω ∝ r^-3/2`. Differential
rotation shears the noise into trailing spirals on its own. Raising the result to
a high power (**wisp sharpness**, ~7) is what breaks a smooth sheet into sparse
bright filaments — that one exponent is most of the look. Two samples a full cycle
apart are crossfaded so the animation loops seamlessly instead of shearing into
mush after a few minutes.

**Relativistic shift.** Orbital speed is Keplerian, `β = √(rs/2r)`, giving a
Doppler factor `δ = 1/(γ(1 - β·n̂))` combined with the gravitational redshift
`√(1 - rs/r)`. Since `I_ν/ν³` is a relativistic invariant, observed intensity
scales as `g³` — that is why the side rotating towards you is dramatically
brighter and bluer. Set **doppler beaming** to 0 to flatten it.

**Photon ring.** Rays whose impact parameter sits exactly at `3√3/2` orbit the
hole an unbounded number of times, carrying an infinite series of ever-fainter
disk images that no finite step budget can resolve. Because `b` is conserved
along the geodesic it can be computed once from the initial conditions, so that
missing light is added back analytically as a narrow band straddling the shadow's
edge.

**Colour** has two modes. The *stylised ramp* saturates around 10000K for a punchy
red → orange → yellow → blue-white sweep (this is the fiery look); the physical
*Planck locus* gives correct warm whites and is what the Interstellar preset uses.

## Performance

Cost is dominated by `ray steps` × pixels. If it runs slow, in order: drop
**resolution scale**, lower **ray steps** (140 still looks good), reduce **max
winding** (3π keeps the main lensed images, only the faintest repeats are lost).
**Supersample 2x2** quadruples the cost and is meant for stills — turn it on
before pressing `S`.

## Layout

```
index.html                       canvas, overlay, styling
src/main.js                      renderer, camera, post-processing, GUI, presets
src/shaders/blackhole.frag.glsl  the whole scene
src/shaders/blackhole.vert.glsl  full-screen quad
```

`three` is the only runtime dependency.
