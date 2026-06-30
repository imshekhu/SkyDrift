import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { SITES } from '../world/Sites'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — WaterFX
//
// Makes the blue ocean feel ALIVE with a thin overlay of emissive, bloom-friendly
// effects floating a hair ABOVE the blue crust (radius 640 + tiny lift), so the
// crust itself is never replaced or z-fought. Three layers, all additive / HDR:
//
//   • FOAM RINGS  — one soft white emissive ring hugging each island's waterline
//                   (a flat torus at radius 640, tangent to the sphere, sized to
//                   ~0.72 of the island radius). Each ring gently pulses in
//                   brightness + breathes a touch in scale so the surf reads.
//   • SPARKLES    — a global field of ~800 tiny additive glints (THREE.Points,
//                   white→cyan, toneMapped:false) sprinkled over the open ocean
//                   away from the islands. They TWINKLE: per-point size + alpha
//                   oscillate on independent phases like sun glints on water.
//   • RIPPLES     — a handful of faint expanding ring "decals" near islands that
//                   grow + fade then respawn, like a fish breaking the surface.
//
// All effects sit just above radius 640 (the blue surface), exempt from the
// surface clutter ceiling by being flat & paper-thin, and stay well inside
// CAMERA_FAR. Zero allocation in update(): every temp lives at closure scope.
//
// Anchoring follows the lighthouse convention exactly: an `up` unit vector from
// each SITES[i].dir, position = up * R, quaternion aligning +Y → up, sub-pieces
// offset in the local tangent X/Z plane. Foam/ripples/sparkles are WATER-LEVEL
// effects, so R = planet.radius (the blue crust), nudged out by a paper-thin lift.
// ─────────────────────────────────────────────────────────────────────────────

const UP_Y = new THREE.Vector3(0, 1, 0)

// How far above the blue crust the overlays float (paper-thin; pure visual).
const SURF_LIFT = 0.4 // → radius ≈ 640.4

// FOAM: ring sits at this fraction of the island's landmass radius (the waterline).
const FOAM_FRAC = 0.72
const FOAM_THICK = 1.4 // torus tube radius (world units) — soft surf band

// SPARKLES
const SPARKLE_COUNT = 800
const SPARKLE_BASE_SIZE = 7.0 // px (sizeAttenuation off → screen-space, mobile-kind)

// RIPPLES: a small pool of expanding rings that respawn near random coasts.
const RIPPLE_COUNT = 14
const RIPPLE_MIN_R = 3 // world units (start)
const RIPPLE_MAX_R = 26 // world units (fully expanded, then fade+respawn)
const RIPPLE_GROW = 9 // world units / sec

// ── module-scope scratch (NO allocation in update) ────────────────────────────
const _up = new THREE.Vector3()
const _tanA = new THREE.Vector3()
const _tanB = new THREE.Vector3()
const _q = new THREE.Quaternion()

interface RippleState {
  group: THREE.Group
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  siteIdx: number
  ang: number // angle around the island for placement variety
  r: number // current radius (world units)
  phase: number // 0..1 staggered start
}

export function createWaterFXSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'waterfx'

  // ── FOAM rings ──────────────────────────────────────────────────────────────
  // One white additive torus per island, laid flat (its plane tangent to the
  // sphere) and seated on the blue surface around the island's waterline.
  const foamMats: THREE.MeshBasicMaterial[] = []
  const foamMeshes: THREE.Mesh[] = []
  const foamPhase: number[] = []

  // ── SPARKLES (one global Points cloud) ────────────────────────────────────────
  let sparkles: THREE.Points | null = null
  let sparkleMat: THREE.PointsMaterial | null = null
  let sparkleGeo: THREE.BufferGeometry | null = null
  // Per-point twinkle bookkeeping (parallel arrays; written into the color attr).
  // NOTE: stock THREE.PointsMaterial has ONE material-wide `size` and ignores a
  // per-vertex size attribute, so the twinkle is driven purely through the HDR
  // vertex COLOUR (brightness up/down). With additive blending that reads as a
  // glint blinking on/off — and it blooms — without any custom shader.
  let twPhase: Float32Array | null = null
  let twSpeed: Float32Array | null = null
  let colorAttr: THREE.BufferAttribute | null = null
  let sparkleBaseCol: Float32Array | null = null // base r,g,b per point (HDR)

  // ── RIPPLES ──────────────────────────────────────────────────────────────────
  const ripples: RippleState[] = []
  let rippleGeo: THREE.RingGeometry | null = null

  // shared, deterministic-ish: we use ctx.rand() at init only.

  return {
    name: 'waterfx',

    init(ctx: GameContext): void {
      const R = ctx.planet.radius // blue crust = 640 (water level)
      const Rsurf = R + SURF_LIFT

      // ── FOAM rings around each island ──────────────────────────────────────
      for (let i = 0; i < SITES.length; i++) {
        const site = SITES[i]
        _up.set(site.dir[0], site.dir[1], site.dir[2]).normalize()
        const ringR = Math.max(8, site.radius * FOAM_FRAC)
        // Flat torus in the XZ-plane (so it lies tangent to the sphere after the
        // +Y→up rotation). radialSegments low (flat-shaded look), tubularSegments
        // enough to read as a smooth circle.
        const geo = new THREE.TorusGeometry(ringR, FOAM_THICK, 6, 40)
        geo.rotateX(Math.PI / 2) // torus plane → XZ (normal = +Y)
        const mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(0.7, 0.85, 0.95), // soft white-cyan surf (dim, gentle bloom)
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          toneMapped: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          fog: false,
        })
        const m = new THREE.Mesh(geo, mat)
        m.position.copy(_up).multiplyScalar(Rsurf)
        m.quaternion.setFromUnitVectors(UP_Y, _up)
        m.renderOrder = 2
        m.name = `waterfx.foam.${site.name}`
        root.add(m)
        foamMeshes.push(m)
        foamMats.push(mat)
        foamPhase.push(ctx.rand() * Math.PI * 2)
      }

      // ── SPARKLES: ~800 glints over the OPEN ocean (away from islands) ────────
      const positions = new Float32Array(SPARKLE_COUNT * 3)
      const colors = new Float32Array(SPARKLE_COUNT * 3)
      twPhase = new Float32Array(SPARKLE_COUNT)
      twSpeed = new Float32Array(SPARKLE_COUNT)
      sparkleBaseCol = new Float32Array(SPARKLE_COUNT * 3)

      let placed = 0
      let guard = 0
      while (placed < SPARKLE_COUNT && guard < SPARKLE_COUNT * 20) {
        guard++
        // Uniform point on the sphere (rejection-free): z uniform, theta uniform.
        const z = ctx.rand() * 2 - 1
        const th = ctx.rand() * Math.PI * 2
        const rr = Math.sqrt(Math.max(0, 1 - z * z))
        const dx = Math.cos(th) * rr
        const dy = z
        const dz = Math.sin(th) * rr

        // Reject points too close to any island (keep glints on open water).
        let onLand = false
        for (let s = 0; s < SITES.length; s++) {
          const sd = SITES[s].dir
          const dot = dx * sd[0] + dy * sd[1] + dz * sd[2] // cos(angle)
          // island angular radius ≈ landmass radius / planet radius (small-angle)
          const angR = (SITES[s].radius * 1.05) / R
          if (dot > Math.cos(angR)) {
            onLand = true
            break
          }
        }
        if (onLand) continue

        const o = placed * 3
        positions[o] = dx * Rsurf
        positions[o + 1] = dy * Rsurf
        positions[o + 2] = dz * Rsurf

        // base colour: white core leaning cyan, HDR so additive bloom catches.
        const cyan = 0.5 + ctx.rand() * 0.5 // 0.5..1
        const r = 1.4
        const g = 1.6
        const b = 1.6 + cyan * 0.8 // 1.6..2.4 — a cool glint
        sparkleBaseCol[o] = r
        sparkleBaseCol[o + 1] = g
        sparkleBaseCol[o + 2] = b
        colors[o] = r
        colors[o + 1] = g
        colors[o + 2] = b

        twPhase[placed] = ctx.rand() * Math.PI * 2
        twSpeed[placed] = 1.4 + ctx.rand() * 3.2 // independent twinkle rates
        placed++
      }
      // If the guard cut us short, trim the buffers to `placed`.
      const count = placed
      sparkleGeo = new THREE.BufferGeometry()
      sparkleGeo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, count * 3), 3))
      colorAttr = new THREE.BufferAttribute(colors.subarray(0, count * 3), 3)
      colorAttr.setUsage(THREE.DynamicDrawUsage)
      sparkleGeo.setAttribute('color', colorAttr)

      sparkleMat = new THREE.PointsMaterial({
        size: SPARKLE_BASE_SIZE,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        sizeAttenuation: false, // screen-space dots → crisp glints, mobile-kind
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        fog: false,
      })
      sparkles = new THREE.Points(sparkleGeo, sparkleMat)
      sparkles.name = 'waterfx.sparkles'
      sparkles.frustumCulled = false
      root.add(sparkles)

      // ── RIPPLES: a small pool of expanding faint rings near coasts ──────────
      // One thin flat ring geometry reused (scaled per-instance via group.scale).
      rippleGeo = new THREE.RingGeometry(0.86, 1.0, 36)
      rippleGeo.rotateX(-Math.PI / 2) // ring plane → XZ (normal +Y), faces up
      for (let i = 0; i < RIPPLE_COUNT; i++) {
        const siteIdx = (ctx.rand() * SITES.length) | 0
        const mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(1.3, 1.6, 1.8),
          transparent: true,
          opacity: 0.0,
          depthWrite: false,
          toneMapped: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          fog: false,
        })
        const m = new THREE.Mesh(rippleGeo, mat)
        m.renderOrder = 2
        const grp = new THREE.Group()
        grp.add(m)
        grp.name = `waterfx.ripple.${i}`
        root.add(grp)
        const rs: RippleState = {
          group: grp,
          mesh: m,
          mat,
          siteIdx,
          ang: ctx.rand() * Math.PI * 2,
          r: RIPPLE_MIN_R,
          phase: ctx.rand(),
        }
        placeRipple(rs, R, Rsurf)
        ripples.push(rs)
      }

      ctx.scene.add(root)
    },

    update(dt: number, ctx: GameContext): void {
      const t = ctx.elapsed()
      const R = ctx.planet.radius
      const Rsurf = R + SURF_LIFT

      // FOAM: gentle brightness pulse + faint scale breathing per island.
      for (let i = 0; i < foamMats.length; i++) {
        const ph = foamPhase[i]
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.9 + ph) // 0..1
        foamMats[i].opacity = 0.14 + 0.16 * pulse
        const s = 1 + 0.025 * Math.sin(t * 0.7 + ph * 1.3)
        foamMeshes[i].scale.set(s, s, s)
      }

      // SPARKLES: twinkle brightness (HDR colour) on independent phases. With
      // additive blending a near-zero colour vanishes and a bright HDR colour
      // blooms → the glint blinks like sun off ripples. (Stock PointsMaterial
      // has no per-vertex size, so brightness IS the twinkle.)
      if (colorAttr && twPhase && twSpeed && sparkleBaseCol) {
        const cols = colorAttr.array as Float32Array
        const n = cols.length / 3
        for (let i = 0; i < n; i++) {
          const tw = 0.5 + 0.5 * Math.sin(t * twSpeed[i] + twPhase[i]) // 0..1
          const sharp = tw * tw // bias toward "off" so glints flicker, not glow
          const o = i * 3
          const k = 0.1 + 1.25 * sharp // dim → bright HDR (overshoot to bloom)
          cols[o] = sparkleBaseCol[o] * k
          cols[o + 1] = sparkleBaseCol[o + 1] * k
          cols[o + 2] = sparkleBaseCol[o + 2] * k
        }
        colorAttr.needsUpdate = true
      }

      // RIPPLES: expand, fade as they grow, respawn at a new coast point.
      for (let i = 0; i < ripples.length; i++) {
        const rp = ripples[i]
        rp.r += RIPPLE_GROW * dt
        const k = (rp.r - RIPPLE_MIN_R) / (RIPPLE_MAX_R - RIPPLE_MIN_R) // 0..1
        if (k >= 1) {
          // respawn at a fresh random coast
          rp.siteIdx = (ctx.rand() * SITES.length) | 0
          rp.ang = ctx.rand() * Math.PI * 2
          rp.r = RIPPLE_MIN_R
          placeRipple(rp, R, Rsurf)
          rp.mat.opacity = 0
          continue
        }
        rp.group.scale.set(rp.r, rp.r, rp.r)
        // bright at birth, fade out as it widens (ease)
        rp.mat.opacity = 0.5 * (1 - k) * (1 - k)
      }
    },

    dispose(): void {
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh || (o as THREE.Points).isPoints) {
          const g = (m as any).geometry as THREE.BufferGeometry | undefined
          g?.dispose()
          const mm = (m as any).material
          if (Array.isArray(mm)) for (const x of mm) x.dispose()
          else mm?.dispose?.()
        }
      })
      // rippleGeo is shared across ripple meshes; traverse disposed it once via
      // each mesh, which is safe (dispose is idempotent). Null everything out.
      root.parent?.remove(root)
      root.clear()
      foamMats.length = 0
      foamMeshes.length = 0
      foamPhase.length = 0
      ripples.length = 0
      sparkles = null
      sparkleMat = null
      sparkleGeo = null
      colorAttr = null
      twPhase = null
      twSpeed = null
      sparkleBaseCol = null
      rippleGeo = null
    },
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  // Seat a ripple group on the blue surface near its island, offset along a
  // tangent direction so it sits just off the coast (not on the hilltop). Uses
  // module-scope temps → zero allocation.
  function placeRipple(rp: RippleState, R: number, Rsurf: number): void {
    const sd = SITES[rp.siteIdx].dir
    _up.set(sd[0], sd[1], sd[2]).normalize()
    // Build a tangent basis at `up`: pick a helper not parallel to up.
    _tanA.set(0, 1, 0)
    if (Math.abs(_up.dot(_tanA)) > 0.9) _tanA.set(1, 0, 0)
    _tanA.crossVectors(_up, _tanA).normalize() // tangent 1
    _tanB.crossVectors(_up, _tanA).normalize() // tangent 2
    // angular offset to just outside the island radius (at the waterline)
    const offWorld = Math.max(10, SITES[rp.siteIdx].radius * (FOAM_FRAC + 0.05))
    const angOff = offWorld / R // small-angle along the great circle
    const ca = Math.cos(angOff)
    const sa = Math.sin(angOff)
    const cx = Math.cos(rp.ang)
    const sx = Math.sin(rp.ang)
    // direction = up*cos(angOff) + (tangent)*sin(angOff)
    const tx = _tanA.x * cx + _tanB.x * sx
    const ty = _tanA.y * cx + _tanB.y * sx
    const tz = _tanA.z * cx + _tanB.z * sx
    const dirx = _up.x * ca + tx * sa
    const diry = _up.y * ca + ty * sa
    const dirz = _up.z * ca + tz * sa
    rp.group.position.set(dirx * Rsurf, diry * Rsurf, dirz * Rsurf)
    // orient the flat ring tangent to the sphere at this point
    _up.set(dirx, diry, dirz).normalize()
    _q.setFromUnitVectors(UP_Y, _up)
    rp.group.quaternion.copy(_q)
  }
}
