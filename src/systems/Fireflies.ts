import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { FLAT_CORE_GAP } from '../world/Planet'
import { SITES, LAND_HEIGHT } from '../world/Sites'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Fireflies: magical night-life over forest & meadow islands.
//
// For every SITES site whose biome is 'forest' or 'meadow' we conjure a pocket of
// living light, anchored on the island HILLTOP (R = planet.radius − FLAT_CORE_GAP
// + LAND_HEIGHT — exactly where the towns/lamps sit), oriented to the local
// surface normal:
//
//   • FIREFLIES — one shared THREE.Points (additive, warm yellow-green HDR,
//     toneMapped:false → blooms). A few hundred motes hover 1–6u above the ground,
//     each wandering on a pre-seeded sin-based orbit and BLINKING on its own phase.
//     A per-point size attribute + a tiny custom shader injection drive the blink
//     so even hundreds of motes cost one draw call and zero per-frame allocation.
//   • GLOW FLORA — scattered emissive mushroom caps & flower bells on the ground:
//     two small InstancedMesh batches (caps + stems) with HDR MeshBasicMaterial so
//     they bloom like little night-lights. They breathe (slow scale pulse) per
//     instance via a pre-seeded phase, written once into the instance matrices.
//
// All motion is a pure function of (seeded phase + elapsed time): NO Math.random
// in update(), and every temp lives at module/closure scope → zero allocation.
//
// Lighting budget: NO new THREE lights. Everything glows via emissive/additive
// HDR materials so the existing bloom pass lights the night for free. Nothing
// rises above ~6u over the hilltop, far under the 46u flight-band ceiling.
// ─────────────────────────────────────────────────────────────────────────────

const UP_Y = new THREE.Vector3(0, 1, 0)
const col = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

// Per-island swarm sizing (forest is denser/wilder than open meadow).
const FOREST_FLIES = 64
const MEADOW_FLIES = 44
const FOREST_FLORA = 30
const MEADOW_FLORA = 22

// Hover band above the hilltop ground (world units).
const HOVER_MIN = 1.0
const HOVER_MAX = 6.0
// Horizontal wander amplitude as a fraction of the site's landmass radius.
const WANDER_FRAC = 0.34
// Drift speeds (rad/sec) — slow, dreamy.
const DRIFT_A = 0.55
const DRIFT_B = 0.41
const DRIFT_BOB = 0.9

// One firefly mote, fully pre-seeded so update() is pure math.
interface Mote {
  // local tangent-plane anchor on the hilltop (X/Z) + base height (Y)
  cx: number
  cz: number
  cy: number
  // two elliptical wander radii + phase offsets for an organic figure-curve
  rx: number
  rz: number
  pa: number
  pb: number
  // vertical bob amplitude + phase
  by: number
  pBob: number
  // blink: independent period (sec), phase, and a steady floor so it never fully dies
  blinkW: number
  blinkP: number
  // base point size (px) — varied so the swarm has depth
  size: number
  // index into the shared buffers
  i: number
}

// A glow-flora instance: tangent anchor + breathe phase, baked once.
interface Flora {
  m: THREE.Matrix4
  phase: number
  baseScale: number
  i: number
}

export function createFirefliesSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'fireflies'

  // disposal registries
  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []

  // shared firefly buffers (filled in init, written in update)
  let flyGeo: THREE.BufferGeometry | null = null
  let flyPos: THREE.BufferAttribute | null = null
  let flyAlpha: THREE.BufferAttribute | null = null
  const motes: Mote[] = []

  // per-mote site orientation: each mote stores its world anchor directly, so we
  // bake the tangent basis at build time and never need per-frame quaternions.
  // We pre-resolve each mote's world-space basis vectors (up + two tangents).
  const upX: number[] = []
  const upY: number[] = []
  const upZ: number[] = []
  const tAx: number[] = []
  const tAy: number[] = []
  const tAz: number[] = []
  const tBx: number[] = []
  const tBy: number[] = []
  const tBz: number[] = []

  // glow flora batches
  const floraCaps: Flora[] = []
  let capMesh: THREE.InstancedMesh | null = null
  let stemMesh: THREE.InstancedMesh | null = null

  // module-scope scratch — zero allocation in update()
  const _m = new THREE.Matrix4()
  const _q = new THREE.Quaternion()
  const _scale = new THREE.Vector3()
  const _pos = new THREE.Vector3()

  return {
    name: 'fireflies',

    init(ctx: GameContext) {
      const R = ctx.planet.radius - FLAT_CORE_GAP + LAND_HEIGHT

      // ── Count the live (forest/meadow) sites + total motes/flora up front ──────
      const liveSites = SITES.filter((s) => s.biome === 'forest' || s.biome === 'meadow')
      let flyTotal = 0
      let floraTotal = 0
      for (const s of liveSites) {
        flyTotal += s.biome === 'forest' ? FOREST_FLIES : MEADOW_FLIES
        floraTotal += s.biome === 'forest' ? FOREST_FLORA : MEADOW_FLORA
      }
      if (flyTotal === 0) {
        ctx.scene.add(root)
        return
      }

      // ── FIREFLIES — one shared additive THREE.Points (warm yellow-green HDR) ───
      const positions = new Float32Array(flyTotal * 3)
      const alphas = new Float32Array(flyTotal) // per-point blink brightness 0..1
      flyGeo = new THREE.BufferGeometry()
      geos.push(flyGeo)
      flyPos = new THREE.BufferAttribute(positions, 3)
      flyAlpha = new THREE.BufferAttribute(alphas, 1)
      flyPos.setUsage(THREE.DynamicDrawUsage)
      flyAlpha.setUsage(THREE.DynamicDrawUsage)
      flyGeo.setAttribute('position', flyPos)
      flyGeo.setAttribute('aBlink', flyAlpha)

      // a soft round sprite so each mote is a glowing dot, not a hard square
      const sprite = makeGlowSprite()

      // Warm yellow-green HDR base colour (>1 channels → blooms). toneMapped:false.
      const flyMat = new THREE.PointsMaterial({
        size: 3.4,
        map: sprite,
        color: new THREE.Color(2.4, 2.2, 0.7),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        toneMapped: false,
        fog: false,
      })
      mats.push(flyMat)
      // Inject the per-point blink: scale gl_PointSize + fade alpha by aBlink so a
      // mote that is "off" shrinks AND dims (reads as a true blink, still 1 draw).
      flyMat.onBeforeCompile = (shader) => {
        shader.vertexShader =
          'attribute float aBlink;\nvarying float vBlink;\n' +
          shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n  vBlink = aBlink;'
          )
        // multiply the computed point size by the blink factor (kept ≥ a floor)
        shader.vertexShader = shader.vertexShader.replace(
          'gl_PointSize = size;',
          'gl_PointSize = size * (0.45 + 0.55 * vBlink);'
        )
        shader.fragmentShader =
          'varying float vBlink;\n' +
          shader.fragmentShader.replace(
            '#include <color_fragment>',
            '#include <color_fragment>\n  diffuseColor.rgb *= (0.25 + 0.95 * vBlink);'
          )
      }

      const flies = new THREE.Points(flyGeo, flyMat)
      flies.name = 'fireflies.points'
      flies.frustumCulled = false // anchors span the globe; cheap enough, avoids pop
      root.add(flies)

      // glow-flora geometries (shared across all instances)
      const capGeo = new THREE.SphereGeometry(0.62, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5)
      const stemGeo = new THREE.CylinderGeometry(0.12, 0.18, 1.1, 6)
      geos.push(capGeo, stemGeo)
      const capMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.6, 1.9, 1.3), // luminous cyan-green caps
        toneMapped: false,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
      const stemMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.35, 0.7, 0.55),
        toneMapped: false,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
      mats.push(capMat, stemMat)
      capMesh = new THREE.InstancedMesh(capGeo, capMat, floraTotal)
      stemMesh = new THREE.InstancedMesh(stemGeo, stemMat, floraTotal)
      capMesh.name = 'fireflies.flora.caps'
      stemMesh.name = 'fireflies.flora.stems'
      capMesh.frustumCulled = false
      stemMesh.frustumCulled = false
      capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      root.add(stemMesh, capMesh)

      // ── Seed every mote + flora, per live site, in the local tangent plane ─────
      const rand = ctx.rand
      let fi = 0 // running firefly index
      let gi = 0 // running flora index

      for (const site of liveSites) {
        const up = _pos.set(site.dir[0], site.dir[1], site.dir[2]).normalize().clone()
        // build a stable tangent basis (tA, tB) ⟂ up for local X/Z placement
        const tA = new THREE.Vector3()
        const tB = new THREE.Vector3()
        // pick a reference axis least parallel to up to avoid degeneracy
        const ref =
          Math.abs(up.y) < 0.95 ? UP_Y : new THREE.Vector3(1, 0, 0)
        tA.crossVectors(ref, up).normalize()
        tB.crossVectors(up, tA).normalize()

        const span = site.radius * WANDER_FRAC
        const nFlies = site.biome === 'forest' ? FOREST_FLIES : MEADOW_FLIES
        const nFlora = site.biome === 'forest' ? FOREST_FLORA : MEADOW_FLORA

        // fireflies — cluster toward the hilltop centre (sqrt → denser middle)
        for (let k = 0; k < nFlies; k++) {
          const ang = rand() * Math.PI * 2
          const rad = Math.sqrt(rand()) * span
          const cx = Math.cos(ang) * rad
          const cz = Math.sin(ang) * rad
          const cy = HOVER_MIN + rand() * (HOVER_MAX - HOVER_MIN)
          motes.push({
            cx,
            cz,
            cy,
            rx: (0.6 + rand() * 1.6) * (1 + span * 0.012),
            rz: (0.6 + rand() * 1.6) * (1 + span * 0.012),
            pa: rand() * Math.PI * 2,
            pb: rand() * Math.PI * 2,
            by: 0.5 + rand() * 1.4,
            pBob: rand() * Math.PI * 2,
            blinkW: (0.6 + rand() * 1.9) * Math.PI * 2, // ~0.6..2.5 Hz
            blinkP: rand() * Math.PI * 2,
            size: 2.0 + rand() * 3.2,
            i: fi,
          })
          // bake this mote's world basis so update() needs no per-site lookup
          upX[fi] = up.x; upY[fi] = up.y; upZ[fi] = up.z
          tAx[fi] = tA.x; tAy[fi] = tA.y; tAz[fi] = tA.z
          tBx[fi] = tB.x; tBy[fi] = tB.y; tBz[fi] = tB.z
          // PointsMaterial has one global `size`; per-mote size is folded into the
          // blink brightness in update() (smaller motes read dimmer → adds depth).
          fi++
        }

        // glow flora — scattered across a slightly wider disc, on the ground (cy≈0)
        for (let k = 0; k < nFlora; k++) {
          const ang = rand() * Math.PI * 2
          const rad = Math.sqrt(rand()) * span * 1.25
          const lx = Math.cos(ang) * rad
          const lz = Math.sin(ang) * rad
          const baseScale = 0.7 + rand() * 1.1
          // world position = up*R + tangent offsets, lifted so the stem base sits
          // on the ground and the cap floats just above it.
          _pos
            .set(0, 0, 0)
            .addScaledVector(up, R)
            .addScaledVector(tA, lx)
            .addScaledVector(tB, lz)
          // orient +Y → up
          _q.setFromUnitVectors(UP_Y, up)

          // STEM instance: half-height lift along up
          _scale.set(baseScale, baseScale, baseScale)
          _m.compose(
            _tmpLift(_pos, up, baseScale * 0.55, _tmpV),
            _q,
            _scale
          )
          stemMesh.setMatrixAt(gi, _m)

          // CAP instance: sits atop the stem (~1.1 * baseScale up)
          const m2 = new THREE.Matrix4()
          m2.compose(_tmpLift(_pos, up, baseScale * 1.15, _tmpV), _q, _scale)
          capMesh.setMatrixAt(gi, m2)
          floraCaps.push({ m: m2, phase: rand() * Math.PI * 2, baseScale, i: gi })
          gi++
        }
      }

      flyPos!.needsUpdate = true
      stemMesh.instanceMatrix.needsUpdate = true
      capMesh.instanceMatrix.needsUpdate = true

      // stash per-mote base size into a parallel array reused in update (alpha = blink*size01)
      for (const mt of motes) _moteSize[mt.i] = mt.size

      ctx.scene.add(root)
    },

    update(dt: number, ctx: GameContext) {
      void dt
      if (!flyPos || !flyAlpha) return
      const t = ctx.elapsed()
      const posArr = flyPos.array as Float32Array
      const blinkArr = flyAlpha.array as Float32Array

      for (let k = 0; k < motes.length; k++) {
        const m = motes[k]
        const i = m.i
        // local wander: two interfering ellipses + a vertical bob (pure sin)
        const ox = m.cx + Math.cos(t * DRIFT_A + m.pa) * m.rx + Math.sin(t * DRIFT_B + m.pb) * m.rx * 0.4
        const oz = m.cz + Math.sin(t * DRIFT_B + m.pb) * m.rz + Math.cos(t * DRIFT_A + m.pa) * m.rz * 0.4
        const oy = m.cy + Math.sin(t * DRIFT_BOB + m.pBob) * m.by

        // world position = up*R-base + tangentA*ox + tangentB*oz + up*oy
        // (up*R is folded into cy via the baked basis: we add up*(oy) and the
        //  anchor radius is applied through the up component below)
        const ax = tAx[i]
        const ay = tAy[i]
        const az = tAz[i]
        const bx = tBx[i]
        const by = tBy[i]
        const bz = tBz[i]
        const ux = upX[i]
        const uy = upY[i]
        const uz = upZ[i]
        const rBase = _flyR
        const px = ux * rBase + ax * ox + bx * oz + ux * oy
        const py = uy * rBase + ay * ox + by * oz + uy * oy
        const pz = uz * rBase + az * ox + bz * oz + uz * oy
        const j = i * 3
        posArr[j] = px
        posArr[j + 1] = py
        posArr[j + 2] = pz

        // blink: smooth 0..1, with a steady floor so motes never vanish entirely,
        // scaled by this mote's relative size so the swarm twinkles with depth.
        const s = 0.5 + 0.5 * Math.sin(t * m.blinkW * 0.16 + m.blinkP)
        const blink = 0.18 + 0.82 * s * s // gamma → crisp on/off pulses
        blinkArr[i] = blink * (0.55 + 0.45 * (_moteSize[i] / 5.2))
      }
      flyPos.needsUpdate = true
      flyAlpha.needsUpdate = true

      // glow-flora breathe: gentle per-instance scale pulse (cheap, cap only)
      if (capMesh) {
        for (let k = 0; k < floraCaps.length; k++) {
          const f = floraCaps[k]
          const pulse = 1 + 0.16 * Math.sin(t * 1.3 + f.phase)
          // rescale from the baked matrix: decompose → rescale → recompose
          f.m.decompose(_pos, _q, _scale)
          const s = f.baseScale * pulse
          _scale.set(s, s, s)
          _m.compose(_pos, _q, _scale)
          capMesh.setMatrixAt(f.i, _m)
        }
        capMesh.instanceMatrix.needsUpdate = true
      }
    },

    dispose() {
      root.parent?.remove(root)
      for (const g of geos) g.dispose()
      for (const m of mats) m.dispose()
      // dispose the sprite texture if present
      if (capMesh) capMesh.dispose()
      if (stemMesh) stemMesh.dispose()
      if (_spriteTex) {
        _spriteTex.dispose()
        _spriteTex = null
      }
      geos.length = 0
      mats.length = 0
      motes.length = 0
      floraCaps.length = 0
      upX.length = upY.length = upZ.length = 0
      tAx.length = tAy.length = tAz.length = 0
      tBx.length = tBy.length = tBz.length = 0
      flyGeo = null
      flyPos = null
      flyAlpha = null
      capMesh = null
      stemMesh = null
    },
  }

  // ── helpers (closure scope) ────────────────────────────────────────────────

  // Lift a world point `base` (which already sits on the hilltop surface) by
  // `h` units along the surface normal `up`. Writes into / returns `out`.
  function _tmpLift(base: THREE.Vector3, up: THREE.Vector3, h: number, out: THREE.Vector3): THREE.Vector3 {
    out.copy(base).addScaledVector(up, h)
    return out
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// module-scope shared scratch / constants (outside the factory so they persist
// without re-alloc and are reachable from update without `this`).
// ─────────────────────────────────────────────────────────────────────────────

// per-mote base size, indexed by mote.i (filled at end of init)
const _moteSize: number[] = []
// a reusable temp for flora lift
const _tmpV = new THREE.Vector3()
// the firefly anchor radius (hilltop), set lazily from the first build. Because
// every live site shares the same R (planet.radius − FLAT_CORE_GAP + LAND_HEIGHT),
// we can hold it as a single module value; SkyDrift's planet.radius is fixed.
import { PLANET_RADIUS } from '../world/WorldConfig'
const _flyR = PLANET_RADIUS - FLAT_CORE_GAP + LAND_HEIGHT

// soft round additive glow sprite for the fireflies (radial alpha falloff).
let _spriteTex: THREE.Texture | null = null
function makeGlowSprite(): THREE.Texture {
  const size = 64
  const c = document.createElement('canvas')
  c.width = c.height = size
  const x = c.getContext('2d')!
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0.0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,235,0.85)')
  g.addColorStop(0.7, 'rgba(255,255,200,0.25)')
  g.addColorStop(1.0, 'rgba(255,255,200,0)')
  x.fillStyle = g
  x.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  _spriteTex = tex
  return tex
}
