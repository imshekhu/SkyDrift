import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { WORLD_SCALE } from '../world/WorldConfig'
import { FLAT_CORE_GAP } from '../world/Planet'
import { SITES, LAND_HEIGHT } from '../world/Sites'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Wildlife
//
// Ambient life + motion around the SITES islands. THREE families, each an
// InstancedMesh updated by per-instance pre-seeded phase (zero allocation per
// frame, all temps at module/closure scope):
//
//   • BIRD FLOCKS  — small V-shaped low-poly birds circling above several
//     islands on tilted orbital rings, just BELOW the plane cruise altitude
//     (radius+64=704). Wings flap (the V opens/closes) as they fly.
//   • LEAPING FISH — fish/dolphins that arc out of the WATER (radius 640) near
//     island coasts on a looping parabolic hop, spinning forward as they leap
//     and disappearing back under the surface between hops.
//   • BUTTERFLIES  — tiny fluttering butterflies drifting over MEADOW islands'
//     hilltops, wings flicking, bobbing on little wandering loops.
//
// PLACEMENT (anchored exactly like the lighthouse/town conventions):
//   - birds orbit a ring centred on the island, at R = crust + LAND_HEIGHT + alt
//     (well under 704 clearance).
//   - fish leap from the blue surface: base ring at R = planet.radius (640).
//   - butterflies hover on the hilltop: R = crust + LAND_HEIGHT + small height.
// Each instance lives in the island's LOCAL tangent frame (basis built once from
// the island's surface normal), so its little path is computed cheaply in 2D and
// lifted onto the sphere — no per-frame quaternion math.
//
// All emissive-free solids use flat-shaded MeshStandardMaterial (lit by the
// existing 3-light rig). No new THREE lights are created.
// ─────────────────────────────────────────────────────────────────────────────

const S = WORLD_SCALE
const UP_Y = new THREE.Vector3(0, 1, 0)
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const TAU = Math.PI * 2

// ── module-scope scratch (NO allocation inside update) ───────────────────────
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _scale = new THREE.Vector3(1, 1, 1)
const _pos = new THREE.Vector3()
const _nrm = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _up = new THREE.Vector3()
const _side = new THREE.Vector3()
const _tmp = new THREE.Vector3()

// ── geometry builders ────────────────────────────────────────────────────────

// A small flat V-shaped bird: two angled wing triangles sharing a centre spine,
// authored in the XZ plane, +Z = flight forward. The two wings are separate
// triangles so we *could* flap them, but for an InstancedMesh we instead encode
// flap as a tiny non-uniform Y-scale of the whole bird (cheap + reads as a beat).
function makeBirdGeometry(): THREE.BufferGeometry {
  const span = 2.2 * S
  const chord = 1.5 * S
  const sweep = 0.5 * S // wing-tips swept back
  // 4 triangles (top+bottom of each wing) so it's visible from above & below.
  const v: number[] = []
  // wing tips slightly raised (a shallow dihedral) for a gull silhouette
  const tipY = 0.32 * S
  // left wing (−X), right wing (+X); nose at +Z, tail joint at −Z
  const nose: [number, number, number] = [0, 0, chord]
  const tail: [number, number, number] = [0, 0, -sweep]
  const lTip: [number, number, number] = [-span, tipY, -sweep]
  const rTip: [number, number, number] = [span, tipY, -sweep]
  const push = (a: number[], b: number[], c: number[]) => v.push(...a, ...b, ...c)
  // right wing
  push(nose, rTip, tail)
  push(nose, tail, rTip)
  // left wing
  push(nose, tail, lTip)
  push(nose, lTip, tail)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  g.computeVertexNormals()
  return g
}

// A simple low-poly fish/dolphin: a stretched octahedron body + a small tail
// fin. Authored long-axis along +Z (forward through the leap).
function makeFishGeometry(): THREE.BufferGeometry {
  const body = new THREE.OctahedronGeometry(1.0 * S, 0)
  body.scale(0.55, 0.7, 1.9) // slim, elongated
  const tail = new THREE.ConeGeometry(0.9 * S, 1.1 * S, 4)
  tail.rotateX(-Math.PI / 2) // cone axis → -Z (points back)
  tail.translate(0, 0, -2.0 * S)
  tail.scale(1, 0.35, 1) // flatten into a fluke
  const g = mergeOctTail(body, tail)
  body.dispose()
  tail.dispose()
  return g
}

// tiny local merge (avoids importing BufferGeometryUtils for just two parts)
function mergeOctTail(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const an = a.index ? a.toNonIndexed() : a.clone()
  const bn = b.index ? b.toNonIndexed() : b.clone()
  const ap = an.attributes.position.array as ArrayLike<number>
  const bp = bn.attributes.position.array as ArrayLike<number>
  const pos = new Float32Array(ap.length + bp.length)
  pos.set(ap, 0)
  pos.set(bp, ap.length)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  an.dispose()
  bn.dispose()
  return g
}

// A butterfly: two wing quads hinged at a thin body. Built flat in XZ; wings flap
// via a per-instance roll encoded as Y-scale (same trick as the birds).
function makeButterflyGeometry(): THREE.BufferGeometry {
  const w = 0.85 * S
  const l = 1.0 * S
  const v: number[] = []
  const push = (a: number[], b: number[], c: number[]) => v.push(...a, ...b, ...c)
  // right wing pair (fore + hind) as two triangles, mirrored to the left.
  const rFore = [
    [0, 0, l * 0.4],
    [w, 0.05 * S, l * 0.5],
    [w * 0.9, 0.05 * S, -l * 0.1],
  ]
  const rHind = [
    [0, 0, -l * 0.1],
    [w * 0.9, 0.05 * S, -l * 0.1],
    [w * 0.6, 0.05 * S, -l * 0.6],
  ]
  for (const tri of [rFore, rHind]) {
    push(tri[0], tri[1], tri[2])
    push(tri[0], tri[2], tri[1]) // double-sided
    // mirror to left (−X)
    const mir = tri.map((p) => [-p[0], p[1], p[2]])
    push(mir[0], mir[2], mir[1])
    push(mir[0], mir[1], mir[2])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  g.computeVertexNormals()
  return g
}

// ── per-island local frame ───────────────────────────────────────────────────
interface IslandFrame {
  center: THREE.Vector3 // world pos at hilltop centre
  normal: THREE.Vector3 // outward unit normal (= island dir)
  tanX: THREE.Vector3 // a tangent basis vector
  tanZ: THREE.Vector3 // the other tangent basis vector
}

function makeFrame(dir: [number, number, number], R: number): IslandFrame {
  const normal = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize()
  const center = normal.clone().multiplyScalar(R)
  // build a stable tangent basis
  const tanX = new THREE.Vector3()
  const ref = Math.abs(normal.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : UP_Y
  tanX.crossVectors(ref, normal).normalize()
  const tanZ = new THREE.Vector3().crossVectors(normal, tanX).normalize()
  return { center, normal, tanX, tanZ }
}

// ── per-instance descriptors ─────────────────────────────────────────────────
interface Bird {
  f: IslandFrame
  ringR: number // orbit radius in the tangent plane
  alt: number // altitude above the hilltop centre (along normal)
  phase: number // angular position seed
  speed: number // angular speed (rad/s), sign = direction
  flapPhase: number
  flapRate: number
  tiltA: number // ring tilt (cos) for a non-flat banked orbit
  tiltB: number
}

interface Fish {
  f: IslandFrame
  baseR: number // distance from island centre (in tangent plane) of the leap
  ang: number // bearing in the tangent plane
  along: number // small lateral travel direction sign
  hopDur: number // seconds of a single arc
  gap: number // seconds submerged between hops
  phase: number // time offset
  peak: number // peak leap height above water
  spin: number // forward spin rate during the arc
}

interface Fly {
  f: IslandFrame
  cx: number // wander centre in tangent plane
  cz: number
  rad: number // wander loop radius
  phase: number
  rate: number // loop speed
  bob: number // vertical bob amplitude
  baseAlt: number
  flapPhase: number
  flapRate: number
}

// ── system ───────────────────────────────────────────────────────────────────
export function createWildlifeSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'wildlife'

  // materials (flat-shaded solids, lit by the existing rig)
  const birdMat = new THREE.MeshStandardMaterial({
    color: srgb(0x3a3f4a),
    flatShading: true,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  const fishMat = new THREE.MeshStandardMaterial({
    color: srgb(0x6f93b8),
    flatShading: true,
    roughness: 0.5,
    metalness: 0,
  })
  const flyMat = new THREE.MeshStandardMaterial({
    color: srgb(0xf2a33d),
    flatShading: true,
    roughness: 0.8,
    metalness: 0,
    side: THREE.DoubleSide,
  })

  let birdGeo: THREE.BufferGeometry | null = null
  let fishGeo: THREE.BufferGeometry | null = null
  let flyGeo: THREE.BufferGeometry | null = null
  let birdMesh: THREE.InstancedMesh | null = null
  let fishMesh: THREE.InstancedMesh | null = null
  let flyMesh: THREE.InstancedMesh | null = null

  const birds: Bird[] = []
  const fish: Fish[] = []
  const flies: Fly[] = []

  // radii anchored to the world geometry
  // hilltop where birds/butterflies live; water surface where fish leap.
  let R_HILL = 0
  let R_WATER = 0

  // Writes an oriented instance matrix: place at world `_pos`, orient so local
  // +Z faces `fwdWorld` and local +Y faces `upWorld`, with non-uniform scale to
  // fake wing-flap. Zero allocation (uses module scratch).
  function writeInstance(
    mesh: THREE.InstancedMesh,
    i: number,
    sx: number,
    sy: number,
    sz: number,
  ): void {
    // Build a basis from forward (_fwd) & up (_up); side = up × fwd.
    _side.crossVectors(_up, _fwd).normalize()
    // re-orthogonalize up so the basis is clean
    _tmp.crossVectors(_fwd, _side).normalize()
    // rotation matrix columns: X=_side, Y=_tmp, Z=_fwd
    _m.makeBasis(_side, _tmp, _fwd)
    _q.setFromRotationMatrix(_m)
    _scale.set(sx, sy, sz)
    _m.compose(_pos, _q, _scale)
    mesh.setMatrixAt(i, _m)
  }

  return {
    name: 'wildlife',
    init(ctx: GameContext) {
      R_HILL = ctx.planet.radius - FLAT_CORE_GAP + LAND_HEIGHT
      R_WATER = ctx.planet.radius

      // ── seed BIRDS around several islands (skip every-other for variety) ────
      // Altitudes are ABSOLUTE world units (like the building heights in
      // Placements — NOT ×S). R_HILL ≈ 648.3; birds fly "just below the plane"
      // (cruise = 704). alt 30..40 + ≤14 bank → ring peaks ≈ 702 absolute < 704.
      const BIRD_ALT_MIN = 30
      const BIRD_ALT_MAX = 40
      for (let si = 0; si < SITES.length; si++) {
        const site = SITES[si]
        if (si % 2 === 1) continue // flocks over ~half the islands
        const f = makeFrame(site.dir, R_HILL)
        const flock = 5 + ((ctx.rand() * 5) | 0) // 5..9 birds
        const ringR = site.radius * (0.7 + ctx.rand() * 0.5)
        const dir = ctx.rand() < 0.5 ? 1 : -1
        const baseSpeed = (0.18 + ctx.rand() * 0.14) * dir
        // bank wobble in ABSOLUTE world units (small, so the ring never nears 704)
        const tiltA = (ctx.rand() - 0.5) * 14
        const tiltB = (ctx.rand() - 0.5) * 14
        for (let b = 0; b < flock; b++) {
          birds.push({
            f,
            ringR: ringR * (0.85 + ctx.rand() * 0.3),
            alt: BIRD_ALT_MIN + ctx.rand() * (BIRD_ALT_MAX - BIRD_ALT_MIN),
            phase: ctx.rand() * TAU,
            speed: baseSpeed,
            flapPhase: ctx.rand() * TAU,
            flapRate: 7 + ctx.rand() * 4,
            tiltA,
            tiltB,
          })
        }
      }

      // ── seed FISH leaping at island coasts ──────────────────────────────────
      for (let si = 0; si < SITES.length; si++) {
        const site = SITES[si]
        if (si % 3 === 2) continue // fish near ~2/3 of islands
        const f = makeFrame(site.dir, R_WATER) // base ring on the BLUE surface
        const n = 2 + ((ctx.rand() * 3) | 0) // 2..4 fish per coast
        for (let k = 0; k < n; k++) {
          fish.push({
            f,
            baseR: site.radius * (1.0 + ctx.rand() * 0.35), // just off the coast
            ang: ctx.rand() * TAU,
            along: ctx.rand() < 0.5 ? 1 : -1,
            hopDur: 1.3 + ctx.rand() * 0.7,
            gap: 1.5 + ctx.rand() * 3.0,
            phase: ctx.rand() * 6,
            // ABSOLUTE world units: peak 18..34 over the water → ≤ 674 < 704.
            peak: 18 + ctx.rand() * 16,
            spin: 1.4 + ctx.rand() * 0.8,
          })
        }
      }

      // ── seed BUTTERFLIES over meadow islands ────────────────────────────────
      for (let si = 0; si < SITES.length; si++) {
        const site = SITES[si]
        if (site.biome !== 'meadow') continue
        const f = makeFrame(site.dir, R_HILL)
        const n = 8 + ((ctx.rand() * 8) | 0) // 8..15 per meadow
        const spread = site.radius * 0.55
        for (let k = 0; k < n; k++) {
          const a = ctx.rand() * TAU
          const rr = spread * Math.sqrt(ctx.rand())
          flies.push({
            f,
            cx: Math.cos(a) * rr,
            cz: Math.sin(a) * rr,
            rad: (1.5 + ctx.rand() * 3.5) * S,
            phase: ctx.rand() * TAU,
            rate: 0.8 + ctx.rand() * 1.4,
            // bob/baseAlt in ABSOLUTE world units: butterflies hover LOW over the
            // hilltop (≤ ~25 over R_HILL ≈ 648 → ≤ 673, well below 704).
            bob: 2 + ctx.rand() * 4,
            baseAlt: 6 + ctx.rand() * 14,
            flapPhase: ctx.rand() * TAU,
            flapRate: 12 + ctx.rand() * 8,
          })
        }
      }

      // ── instanced meshes ─────────────────────────────────────────────────────
      birdGeo = makeBirdGeometry()
      fishGeo = makeFishGeometry()
      flyGeo = makeButterflyGeometry()

      if (birds.length > 0) {
        birdMesh = new THREE.InstancedMesh(birdGeo, birdMat, birds.length)
        birdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        birdMesh.frustumCulled = false
        birdMesh.name = 'wildlife-birds'
        root.add(birdMesh)
      }
      if (fish.length > 0) {
        fishMesh = new THREE.InstancedMesh(fishGeo, fishMat, fish.length)
        fishMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        fishMesh.frustumCulled = false
        fishMesh.name = 'wildlife-fish'
        root.add(fishMesh)
      }
      if (flies.length > 0) {
        flyMesh = new THREE.InstancedMesh(flyGeo, flyMat, flies.length)
        flyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        flyMesh.frustumCulled = false
        flyMesh.name = 'wildlife-butterflies'
        root.add(flyMesh)
      }

      ctx.scene.add(root)
    },

    update(_dt: number, ctx: GameContext) {
      const t = ctx.elapsed()

      // ── BIRDS: banked orbital rings, wings flapping via Y-scale ──────────────
      if (birdMesh) {
        for (let i = 0; i < birds.length; i++) {
          const b = birds[i]
          const a = b.phase + t * b.speed
          const ca = Math.cos(a)
          const sa = Math.sin(a)
          // tangent-plane offset on a tilted ring (tiltA/B lift the ring out of
          // the flat tangent plane → a gentle banked, non-planar circle)
          const ox = ca * b.ringR
          const oz = sa * b.ringR
          const lift = b.alt + (b.tiltA * ca + b.tiltB * sa)
          // world position = centre + tanX*ox + tanZ*oz + normal*lift
          const f = b.f
          _pos.copy(f.center)
          _pos.addScaledVector(f.tanX, ox)
          _pos.addScaledVector(f.tanZ, oz)
          _pos.addScaledVector(f.normal, lift)
          // forward = tangent of the orbit (derivative), projected into world.
          // d/da of (cos a, sin a) is (−sin a, cos a); reverse for CW orbits.
          _fwd.set(0, 0, 0)
          _fwd.addScaledVector(f.tanX, -sa)
          _fwd.addScaledVector(f.tanZ, ca)
          if (b.speed < 0) _fwd.multiplyScalar(-1)
          _fwd.normalize()
          // up ≈ local outward normal so birds bank over the island
          _up.copy(f.normal)
          // wing flap: open/close the dihedral via Y scale oscillation
          const flap = 0.6 + 0.55 * Math.sin(b.flapPhase + t * b.flapRate)
          writeInstance(birdMesh, i, 1, flap, 1)
        }
        birdMesh.instanceMatrix.needsUpdate = true
      }

      // ── FISH: parabolic leaps out of the water near the coast ────────────────
      if (fishMesh) {
        for (let i = 0; i < fish.length; i++) {
          const fi = fish[i]
          const f = fi.f
          const period = fi.hopDur + fi.gap
          let local = (t + fi.phase) % period
          const ca = Math.cos(fi.ang)
          const sa = Math.sin(fi.ang)
          // anchor point on the water ring (in tangent plane)
          const bx = ca * fi.baseR
          const bz = sa * fi.baseR
          if (local > fi.hopDur) {
            // submerged: hide the fish just below the surface (tiny scale)
            _pos.copy(f.center)
            _pos.addScaledVector(f.tanX, bx)
            _pos.addScaledVector(f.tanZ, bz)
            _pos.addScaledVector(f.normal, -2 * S)
            _fwd.copy(f.tanX) // arbitrary
            _up.copy(f.normal)
            writeInstance(fishMesh, i, 0.001, 0.001, 0.001)
            continue
          }
          // arc param u ∈ [0,1] across the leap
          const u = local / fi.hopDur
          // height: parabola peaking at u=0.5
          const h = fi.peak * 4 * u * (1 - u)
          // small lateral travel along the coast tangent during the leap
          const tx = -sa * fi.along
          const tz = ca * fi.along
          const travel = (u - 0.5) * fi.baseR * 0.18
          const px = bx + tx * travel
          const pz = bz + tz * travel
          _pos.copy(f.center)
          _pos.addScaledVector(f.tanX, px)
          _pos.addScaledVector(f.tanZ, pz)
          _pos.addScaledVector(f.normal, h)
          // forward points along the arc: tangent travel + vertical component
          // dH/du = peak*4*(1-2u); blend travel dir with normal*dH (normalized)
          const dH = fi.peak * 4 * (1 - 2 * u)
          _fwd.set(0, 0, 0)
          _fwd.addScaledVector(f.tanX, tx * fi.baseR * 0.18)
          _fwd.addScaledVector(f.tanZ, tz * fi.baseR * 0.18)
          _fwd.addScaledVector(f.normal, dH)
          _fwd.normalize()
          // up: roll the fish a touch as it spins forward (use normal as base)
          _up.copy(f.normal)
          // a forward "spin" reads as a flipping leap → wobble the up vector
          const roll = Math.sin(local * fi.spin * Math.PI) * 0.5
          _up.addScaledVector(f.tanX, roll * ca)
          _up.addScaledVector(f.tanZ, roll * sa)
          _up.normalize()
          writeInstance(fishMesh, i, 1, 1, 1)
        }
        fishMesh.instanceMatrix.needsUpdate = true
      }

      // ── BUTTERFLIES: wandering loops + bob, wings flicking ───────────────────
      if (flyMesh) {
        for (let i = 0; i < flies.length; i++) {
          const fl = flies[i]
          const f = fl.f
          const a = fl.phase + t * fl.rate
          const ca = Math.cos(a)
          const sa = Math.sin(a)
          // a small drifting loop around the wander centre
          const ox = fl.cx + ca * fl.rad
          const oz = fl.cz + sa * fl.rad * 0.7
          const alt = fl.baseAlt + Math.sin(a * 1.7 + fl.phase) * fl.bob
          _pos.copy(f.center)
          _pos.addScaledVector(f.tanX, ox)
          _pos.addScaledVector(f.tanZ, oz)
          _pos.addScaledVector(f.normal, alt)
          // forward = loop tangent
          _fwd.set(0, 0, 0)
          _fwd.addScaledVector(f.tanX, -sa)
          _fwd.addScaledVector(f.tanZ, ca * 0.7)
          _fwd.normalize()
          _up.copy(f.normal)
          // flap the wings hard + fast
          const flap = 0.25 + 0.75 * Math.abs(Math.sin(fl.flapPhase + t * fl.flapRate))
          writeInstance(flyMesh, i, flap, 1, 1)
        }
        flyMesh.instanceMatrix.needsUpdate = true
      }
    },

    dispose() {
      root.parent?.remove(root)
      birdGeo?.dispose()
      fishGeo?.dispose()
      flyGeo?.dispose()
      birdMat.dispose()
      fishMat.dispose()
      flyMat.dispose()
      birdMesh?.dispose()
      fishMesh?.dispose()
      fishMesh = null
      birdMesh = null
      flyMesh = null
      birdGeo = null
      fishGeo = null
      flyGeo = null
      birds.length = 0
      fish.length = 0
      flies.length = 0
      root.clear()
    },
  }
}
