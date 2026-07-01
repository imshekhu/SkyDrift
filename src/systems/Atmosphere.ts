import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { CAMERA_FAR } from '../world/WorldConfig'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Atmosphere: a glowing airglow halo around the planet for depth.
//
// Two concentric BackSide shells centred at the world ORIGIN (NOT recentred on
// the camera — they wrap the planet, so the rim glow always hugs the true limb):
//
//   1) AIRGLOW SHELL   — radius ≈ planet.radius*1.06 (≈680). A ShaderMaterial
//      computes a fresnel term (1 - |dot(viewDir, normal)|): bright at the limb,
//      transparent through the centre so the surface is never occluded. Colour
//      ramps soft blue (inner) → cyan (rim). Additive, depthWrite:false, fog:false.
//
//   2) HAZE SHELL      — radius ≈ planet.radius*1.094 (≈700). A fainter, wider
//      second fresnel band for a layered, soft-edged glow that fades into space.
//
// Both bloom (HDR colour via toneMapped:false channels) and never write depth, so
// they can't hide the islands/water beneath. A gentle breathing pulse + a very
// slow counter-rotation keep the halo alive without any per-frame allocation.
//
// Anchored at origin (position 0,0,0). Outer radius (≈700) ≪ CAMERA_FAR (≈2800),
// and the camera sits ~704 from origin, so the far limb (≤700+704≈1404) stays
// well inside the far plane. Nothing here rises near the plane's surface clearance
// because it is sky/atmosphere, exempt from the surface height cap.
// Zero allocation in update(): the only mutated state is uniform scalars.
// ─────────────────────────────────────────────────────────────────────────────

// Fresnel airglow shader — view-dependent rim brightness, transparent centre.
// `uColorInner`/`uColorRim` are HDR (channels may exceed 1) so the rim blooms.
const AIRGLOW_VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewW;
  void main() {
    // World-space normal of the (origin-centred) shell.
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vViewW = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const AIRGLOW_FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vNormalW;
  varying vec3 vViewW;
  uniform vec3  uColorInner; // soft blue, seen looking "through" toward the centre
  uniform vec3  uColorRim;   // cyan, brightest at the grazing limb
  uniform float uPower;      // fresnel falloff exponent (higher = thinner rim)
  uniform float uIntensity;  // global brightness (breathing pulse drives this)
  void main() {
    // We render BackSide, so the geometric normal points inward; flip it to get
    // the outward shell normal, then take the grazing term against the view dir.
    vec3 n = normalize(-vNormalW);
    float ndv = abs(dot(n, normalize(vViewW)));      // 0 at the limb, 1 dead-centre
    float fres = pow(1.0 - ndv, uPower);             // bright rim, ~0 through centre
    vec3  col  = mix(uColorInner, uColorRim, fres);  // blue core → cyan limb
    float a    = fres * uIntensity;                  // alpha follows the rim
    gl_FragColor = vec4(col * a, a);                 // premultiplied; additive-friendly
  }
`

// ── module-scope scratch — NO allocation inside update() ──────────────────────
type GlowUniforms = {
  uColorInner: { value: THREE.Color }
  uColorRim: { value: THREE.Color }
  uPower: { value: number }
  uIntensity: { value: number }
}

export function createAtmosphereSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'atmosphere'

  // disposal registries
  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []

  // breathing-pulse base intensities (uniforms are pulsed around these)
  let glowBaseI = 1.0
  let hazeBaseI = 1.0
  let glowUniforms: GlowUniforms | null = null
  let hazeUniforms: GlowUniforms | null = null
  let acc = 0

  const makeShell = (
    radius: number,
    segments: number,
    inner: THREE.Color,
    rim: THREE.Color,
    power: number,
    intensity: number
  ): { mesh: THREE.Mesh; uniforms: GlowUniforms } => {
    const geo = new THREE.IcosahedronGeometry(radius, segments)
    geos.push(geo)
    const uniforms: GlowUniforms = {
      uColorInner: { value: inner },
      uColorRim: { value: rim },
      uPower: { value: power },
      uIntensity: { value: intensity },
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: uniforms as unknown as { [k: string]: THREE.IUniform },
      vertexShader: AIRGLOW_VERT,
      fragmentShader: AIRGLOW_FRAG,
      side: THREE.BackSide, // render the inner faces → halo wraps the planet's limb
      transparent: true,
      depthWrite: false, // never occlude the surface beneath
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false, // keep HDR channels intact so the rim blooms
      fog: false,
    })
    mats.push(mat)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false // it's centred at origin and always relevant
    return { mesh, uniforms }
  }

  return {
    name: 'atmosphere',

    init(ctx: GameContext) {
      const r = ctx.planet.radius // 640

      // HDR colours (channels >1 → bloom). Soft blue inner, brighter cyan rim.
      const glowInner = new THREE.Color(0.1, 0.24, 0.55) // deep sky blue, dim
      const glowRim = new THREE.Color(0.28, 0.72, 1.05) // soft cyan limb
      const hazeInner = new THREE.Color(0.06, 0.16, 0.36) // fainter blue
      const hazeRim = new THREE.Color(0.16, 0.42, 0.72) // soft cyan, gentler

      // ── 1) AIRGLOW SHELL — a THIN rim hugging the planet limb, ≈653 ────────
      glowBaseI = 0.7
      const glow = makeShell(r * 1.02, 5, glowInner, glowRim, 5.0, glowBaseI)
      glow.mesh.name = 'atmosphere.airglow'
      glow.mesh.renderOrder = 5 // after the opaque surface, before HUD sprites
      glowUniforms = glow.uniforms
      root.add(glow.mesh)

      // ── 2) HAZE SHELL — a fainter, slightly wider rim just outside it, ≈666 ─
      hazeBaseI = 0.36
      const haze = makeShell(r * 1.04, 5, hazeInner, hazeRim, 3.4, hazeBaseI)
      haze.mesh.name = 'atmosphere.haze'
      haze.mesh.renderOrder = 4
      hazeUniforms = haze.uniforms
      root.add(haze.mesh)

      // Anchored at the world origin (around the planet), NOT on the camera.
      root.position.set(0, 0, 0)

      // Defensive: keep the whole halo well inside the camera far plane.
      // (outer limb ≈ 700 + camera distance ~704 ≈ 1404 ≪ CAMERA_FAR≈2840.)
      if (r * 1.094 > CAMERA_FAR) root.scale.setScalar(CAMERA_FAR / (r * 1.094) * 0.9)

      ctx.scene.add(root)
    },

    update(dt: number, _ctx: GameContext) {
      acc += dt
      // Gentle, slow breathing pulse on both shells (offset phases) — the airglow
      // swells while the haze ebbs, for a living, layered shimmer. Pure scalar
      // writes into existing uniforms → zero allocation.
      if (glowUniforms) {
        glowUniforms.uIntensity.value = glowBaseI * (0.86 + 0.14 * Math.sin(acc * 0.55))
      }
      if (hazeUniforms) {
        hazeUniforms.uIntensity.value = hazeBaseI * (0.82 + 0.18 * Math.sin(acc * 0.41 + 2.1))
      }
      // Very slow counter-rotation so the fresnel band isn't perfectly static
      // (subtle — the shells are radially symmetric, so this only animates the
      // tiny per-facet normal jitter from the icosa tessellation).
      root.rotation.y += dt * 0.008
    },

    dispose() {
      root.parent?.remove(root)
      for (const g of geos) g.dispose()
      for (const m of mats) m.dispose()
      geos.length = 0
      mats.length = 0
      glowUniforms = null
      hazeUniforms = null
    },
  }
}
