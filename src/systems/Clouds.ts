import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Clouds
//
// A shell of drifting low-poly cumulus puffs floating BETWEEN the crust and the
// plane's cruise band, so you fly OVER them and see the islands poke through.
//
// GEOMETRY / ANCHORING (matches the world's placement contract):
//   • crust (blue surface)    = planet.radius              = 640
//   • plane cruise            = planet.radius + 64         = 704
//   • CLOUD SHELL             = planet.radius + 35..55     ≈ 675..695
//     → safely above the tallest surface props (top < 686) and below cruise, so
//       the player always flies over the cloud deck. Each cloud is a small
//       cluster of flattened low-poly icosahedra, oriented flat to the local
//       surface normal (+Y = outward), spread over the globe by a Fibonacci
//       sphere jittered with ctx.rand() so they read as scattered, not gridded.
//
// PERF: all puffs are drawn by a SMALL set of THREE.InstancedMesh — one per puff
// geometry variant — so 60–90 clouds (each ~5 puffs) cost only a handful of draw
// calls. Soft off-white MeshStandardMaterial with a faint emissive so the bloom
// just barely catches the tops; NOT additive (clouds shouldn't glow like lamps).
//
// UPDATE: the whole shell drifts (parent group yaw) a touch, and each puff bobs
// subtly on its own phase. Zero per-frame allocation — every temp is module/
// closure scope, and instance transforms are rebuilt from cached base data.
// ─────────────────────────────────────────────────────────────────────────────

const UP_Y = new THREE.Vector3(0, 1, 0)
const sc = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

// ── tuning ────────────────────────────────────────────────────────────────────
const CLOUD_COUNT = 78 // ~60–90 clouds spread over the globe
const SHELL_MIN = 35 // metres above the crust for the lowest cloud base
const SHELL_SPAN = 20 // …up to +20 higher → shell ≈ radius+35..55 ≈ 675..695
const PUFF_MIN = 4 // puffs per cloud cluster
const PUFF_MAX = 7
const CLOUD_SCALE_MIN = 5.0 // base puff radius (world units) before per-puff jitter
const CLOUD_SCALE_MAX = 9.0
const FLATTEN = 0.42 // vertical squash → pancake cumulus, not spheres
const SPREAD_XZ = 1.7 // how far puffs fan out in the local tangent plane (× scale)
const DRIFT_RATE = 0.0065 // rad/sec — slow global shell yaw
const BOB_AMP = 0.9 // world units — per-puff vertical bob amplitude
const BOB_FREQ = 0.5 // rad/sec base bob speed

// off-white cloud body with a whisper of emissive so bloom kisses the crowns.
const CLOUD_TINT = sc(0xf3f6fb)
const CLOUD_EMISSIVE = sc(0x5a6478) // low-level, multiplied by a small intensity

// We bucket puffs into a few geometry "variants" (different icosahedron detail/
// proportions) so the deck has visual variety while staying to few InstancedMesh.
const VARIANTS = 3

// ── module-scope scratch (NO allocation in update) ─────────────────────────────
const _q = new THREE.Quaternion()
const _up = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _local = new THREE.Vector3()

// Per-instance baked data (parallel arrays, indexed per variant bucket).
interface Bucket {
  mesh: THREE.InstancedMesh
  count: number
  // base local-tangent offset of the puff within its cloud (relative to cloud anchor)
  ox: Float32Array
  oy: Float32Array
  oz: Float32Array
  // per-instance scale (already flattened in Y separately)
  sx: Float32Array
  sy: Float32Array
  sz: Float32Array
  // the cloud anchor up-vector (unit surface dir) and shell radius for this puff
  ux: Float32Array
  uy: Float32Array
  uz: Float32Array
  rad: Float32Array
  // bob phase + per-instance bob speed
  phase: Float32Array
  bobk: Float32Array
}

export function createCloudsSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'clouds'

  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []
  const buckets: Bucket[] = []

  // soft, flat-shaded cloud material — faint emissive so the bloom just grazes it
  const cloudMat = new THREE.MeshStandardMaterial({
    color: CLOUD_TINT,
    emissive: CLOUD_EMISSIVE,
    emissiveIntensity: 0.35,
    roughness: 1.0,
    metalness: 0.0,
    flatShading: true,
  })
  mats.push(cloudMat)

  return {
    name: 'clouds',

    init(ctx: GameContext): void {
      const rand = ctx.rand
      const R = ctx.planet.radius

      // 1) Decide a puff layout for every cloud up front so we know exact instance
      //    counts per variant bucket → allocate tight InstancedMeshes.
      const counts = new Array<number>(VARIANTS).fill(0)
      // temp layout records; consumed immediately into the typed arrays below.
      interface PuffRec {
        v: number
        ox: number
        oy: number
        oz: number
        sx: number
        sy: number
        sz: number
        ux: number
        uy: number
        uz: number
        rad: number
        phase: number
        bobk: number
      }
      const recs: PuffRec[] = []

      const GOLDEN = Math.PI * (3 - Math.sqrt(5))
      for (let c = 0; c < CLOUD_COUNT; c++) {
        // Fibonacci-sphere base direction, jittered so it isn't a perfect lattice.
        const yy = 1 - ((c + 0.5) / CLOUD_COUNT) * 2 + (rand() - 0.5) * 0.04
        const yClamped = Math.max(-0.999, Math.min(0.999, yy))
        const rRing = Math.sqrt(Math.max(0, 1 - yClamped * yClamped))
        const th = GOLDEN * c + (rand() - 0.5) * 0.6
        const ux = Math.cos(th) * rRing
        const uy = yClamped
        const uz = Math.sin(th) * rRing
        const ulen = Math.hypot(ux, uy, uz) || 1
        const nux = ux / ulen
        const nuy = uy / ulen
        const nuz = uz / ulen

        // shell radius for this whole cloud (puffs share it; bob nudges per-puff)
        const shellR = R + SHELL_MIN + rand() * SHELL_SPAN

        const nPuffs = PUFF_MIN + ((rand() * (PUFF_MAX - PUFF_MIN + 1)) | 0)
        const cloudScale = CLOUD_SCALE_MIN + rand() * (CLOUD_SCALE_MAX - CLOUD_SCALE_MIN)

        for (let p = 0; p < nPuffs; p++) {
          const v = (rand() * VARIANTS) | 0
          counts[v]++
          // fan the puffs out in the local tangent X/Z plane, clustered toward
          // the centre; first puff sits at the core for a solid heart.
          const ang = rand() * Math.PI * 2
          const rad = p === 0 ? 0 : Math.pow(rand(), 0.7) * SPREAD_XZ * cloudScale
          const ox = Math.cos(ang) * rad
          const oz = Math.sin(ang) * rad
          // slight vertical stagger so crowns aren't all coplanar
          const oy = (rand() - 0.35) * cloudScale * 0.5
          // per-puff scale, flattened in Y for a pancake-cumulus silhouette
          const s = cloudScale * (0.55 + rand() * 0.7)
          recs.push({
            v,
            ox,
            oy,
            oz,
            sx: s * (0.85 + rand() * 0.4),
            sy: s * FLATTEN * (0.8 + rand() * 0.5),
            sz: s * (0.85 + rand() * 0.4),
            ux: nux,
            uy: nuy,
            uz: nuz,
            rad: shellR,
            phase: rand() * Math.PI * 2,
            bobk: 0.7 + rand() * 0.8,
          })
        }
      }

      // 2) Build one InstancedMesh per variant, sized to its exact instance count.
      for (let v = 0; v < VARIANTS; v++) {
        const n = counts[v]
        // low-poly puff geometries: chunky icosahedra at detail 0/1 with gentle
        // non-uniform pre-squash baked into the geometry for variety.
        const baseR = 1.0
        const detail = v === 2 ? 1 : 0
        const g = new THREE.IcosahedronGeometry(baseR, detail)
        // bake a touch of asymmetry per variant so repeated instances don't read
        // as identical copies (still flat-shaded blobs).
        if (v === 1) g.scale(1.15, 0.92, 1.0)
        else if (v === 2) g.scale(0.95, 1.0, 1.12)
        geos.push(g)

        const im = new THREE.InstancedMesh(g, cloudMat, Math.max(1, n))
        im.name = `clouds.variant${v}`
        im.castShadow = false
        im.receiveShadow = false
        im.frustumCulled = false // shell wraps the globe; cheap enough, avoids pop
        im.count = n
        root.add(im)

        buckets.push({
          mesh: im,
          count: n,
          ox: new Float32Array(n),
          oy: new Float32Array(n),
          oz: new Float32Array(n),
          sx: new Float32Array(n),
          sy: new Float32Array(n),
          sz: new Float32Array(n),
          ux: new Float32Array(n),
          uy: new Float32Array(n),
          uz: new Float32Array(n),
          rad: new Float32Array(n),
          phase: new Float32Array(n),
          bobk: new Float32Array(n),
        })
      }

      // 3) Fill the per-bucket arrays + write the initial instance matrices.
      const cursor = new Array<number>(VARIANTS).fill(0)
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i]
        const b = buckets[r.v]
        const k = cursor[r.v]++
        b.ox[k] = r.ox
        b.oy[k] = r.oy
        b.oz[k] = r.oz
        b.sx[k] = r.sx
        b.sy[k] = r.sy
        b.sz[k] = r.sz
        b.ux[k] = r.ux
        b.uy[k] = r.uy
        b.uz[k] = r.uz
        b.rad[k] = r.rad
        b.phase[k] = r.phase
        b.bobk[k] = r.bobk
      }

      for (let v = 0; v < VARIANTS; v++) writeBucket(buckets[v], 0)

      ctx.scene.add(root)
    },

    update(dt: number, ctx: GameContext): void {
      // slow global drift of the whole deck around the world's Y axis
      root.rotation.y += dt * DRIFT_RATE
      const t = ctx.elapsed()
      for (let v = 0; v < buckets.length; v++) writeBucket(buckets[v], t)
    },

    dispose(): void {
      root.parent?.remove(root)
      for (const b of buckets) {
        b.mesh.dispose()
        root.remove(b.mesh)
      }
      for (const g of geos) g.dispose()
      for (const m of mats) m.dispose()
      geos.length = 0
      mats.length = 0
      buckets.length = 0
    },
  }
}

// Rebuild every instance matrix in a bucket from its baked base data + a bob.
// Zero allocation: writes through module-scope scratch only.
function writeBucket(b: Bucket, t: number): void {
  const im = b.mesh
  const n = b.count
  for (let k = 0; k < n; k++) {
    // local-tangent → world: orient the unit up-vector to +Y, place puff at the
    // cloud anchor on the shell, offset by its baked tangent (ox,oz)/vertical oy.
    _up.set(b.ux[k], b.uy[k], b.uz[k])
    _q.setFromUnitVectors(UP_Y, _up)

    // subtle vertical bob on the puff's own phase
    const bob = Math.sin(t * BOB_FREQ * b.bobk[k] + b.phase[k]) * BOB_AMP

    // local offset (in the tangent frame where +Y == outward), then rotate to world
    _local.set(b.ox[k], b.oy[k] + bob, b.oz[k]).applyQuaternion(_q)

    // anchor on the shell along the up-vector, then add the rotated local offset
    const rr = b.rad[k]
    _pos.set(_up.x * rr + _local.x, _up.y * rr + _local.y, _up.z * rr + _local.z)

    _scl.set(b.sx[k], b.sy[k], b.sz[k])
    _mat.compose(_pos, _q, _scl)
    im.setMatrixAt(k, _mat)
  }
  im.instanceMatrix.needsUpdate = true
}
