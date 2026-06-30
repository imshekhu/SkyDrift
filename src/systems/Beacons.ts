import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { WORLD_SCALE } from '../world/WorldConfig'
import { FLAT_CORE_GAP } from '../world/Planet'
import { SITES, LAND_HEIGHT } from '../world/Sites'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Beacons
//
// Coastal navigation lights ringing every TOWN island. Two families, both
// emissive-only (no real THREE lights — the existing 3-light rig + bloom carry
// the glow):
//
//   ROTATING BEAMS — a short stone/iron post topped by a glowing lamp that throws
//     a translucent additive light CONE (warm/white, toneMapped:false) sweeping
//     around like a miniature lighthouse. Built with the SAME hollow-cone-along-
//     +X-on-a-pivot technique as Placements.buildLighthouse. Anchored just inside
//     the island edge, BETWEEN the core (634) and crust (640) shells so it reads
//     as "emerging from the blue" like the pinned lighthouse. Each island's beams
//     sweep at slightly different phases/speeds for life.
//
//   BUOYS — blinking emissive marker spheres floating ON THE WATER (radius 640,
//     the blue crust) in a ring around each town island: alternating RED (port)
//     and GREEN (starboard) channel markers, each blinking on its own period in
//     update(). A little weighted base + a topmark keeps them reading as buoys.
//
// All heights < 30u above their base. Zero per-frame allocation in update(): the
// only animated state is beamPivot.rotation.y (a scalar add) and per-buoy lamp
// emissive opacity driven by a closed-form sine of elapsed time. Mobile-friendly:
// buoy lamps share one geometry; beams are a handful per island.
// ─────────────────────────────────────────────────────────────────────────────

const S = WORLD_SCALE
const UP_Y = new THREE.Vector3(0, 1, 0)
const col = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const mat = (hex: number, opts: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color: col(hex), flatShading: true, roughness: 0.8, metalness: 0.05, ...opts })
const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => new THREE.Mesh(g, m)

// HDR glow material that blooms (channels may exceed 1, toneMapped off so AgX
// doesn't crush it). r,g,b in linear HDR space.
const glowHDR = (r: number, g: number, b: number, opts: THREE.MeshBasicMaterialParameters = {}) =>
  new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), toneMapped: false, ...opts })

// ── radii (anchor like the lighthouse) ───────────────────────────────────────
// beams emerge from between the core and crust; buoys float on the blue crust.
const beamRingExtra = 0.5 * S // beam post base lifts a hair above the core so it clears

// A rotating sweep beam — a translucent hollow cone widening outward from a lamp,
// matching Placements.buildLighthouse: cone authored apex→base along +X on a
// pivot we spin about local +Y. Returns the pivot (caller spins it) + the post
// group's total tallest extent for the height check.
interface BeamPost {
  group: THREE.Group
  pivot: THREE.Group
  spin: number
}

function buildBeamPost(rand: () => number): BeamPost {
  const g = new THREE.Group()

  // short tapered post (iron grey) — top ≈ 5.2S ≈ 33? keep small: postH ~3.0S
  const postH = (2.4 + rand() * 0.8) * S // ~15..20u
  const post = mesh(new THREE.CylinderGeometry(0.34 * S, 0.5 * S, postH, 9), mat(0x5b6168))
  post.position.y = postH / 2
  g.add(post)

  // a little railed platform / gallery
  const gallery = mesh(new THREE.CylinderGeometry(0.62 * S, 0.62 * S, 0.16 * S, 10), mat(0x3a3f46))
  gallery.position.y = postH + 0.08 * S
  g.add(gallery)

  // glass lantern housing (faint cyan, translucent — like the hero lighthouse)
  const lightY = postH + 0.5 * S
  const lantern = mesh(
    new THREE.CylinderGeometry(0.4 * S, 0.4 * S, 0.5 * S, 8),
    new THREE.MeshStandardMaterial({ color: col(0x9fe8ff), transparent: true, opacity: 0.38, roughness: 0.1, flatShading: true })
  )
  lantern.position.y = lightY
  g.add(lantern)

  // warm glowing lamp core (blooms)
  const core = mesh(new THREE.SphereGeometry(0.22 * S, 10, 7), glowHDR(2.6, 1.8, 0.7))
  core.position.y = lightY
  g.add(core)

  // little conical cap
  const cap = mesh(new THREE.ConeGeometry(0.46 * S, 0.4 * S, 9), mat(0x9c2f29))
  cap.position.y = lightY + 0.42 * S
  g.add(cap)

  // rotating sweep beam — hollow cone, apex at the lamp, base flaring out at +X.
  const pivot = new THREE.Group()
  pivot.position.y = lightY
  g.add(pivot)
  const beamLen = (6 + rand() * 2.5) * S
  const beamGeo = new THREE.ConeGeometry(0.7 * S, beamLen, 12, 1, true)
  beamGeo.rotateZ(Math.PI / 2) // apex → -X, base → +X
  beamGeo.translate(beamLen / 2, 0, 0) // apex at the lamp, base out at +X
  const beam = new THREE.Mesh(
    beamGeo,
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.6, 1.35, 0.8), // warm HDR so it blooms softly
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
  )
  // tilt the beam very slightly upward so it sweeps just over the water, not into it
  beam.rotation.z = 0.06
  pivot.add(beam)

  return { group: g, pivot, spin: 0.55 + rand() * 0.7 }
}

// A channel buoy floating on the water — weighted base, blinking lamp + topmark.
interface BuoyInstance {
  lampMat: THREE.MeshBasicMaterial
  baseHi: number // peak emissive brightness (HDR)
  phase: number // blink phase offset
  rate: number // blink rate (Hz-ish)
}

function buildBuoy(isRed: boolean, rand: () => number): { group: THREE.Group; inst: BuoyInstance } {
  const g = new THREE.Group()
  const bodyHex = isRed ? 0xc8352b : 0x2fae57
  const body = mat(bodyHex, { roughness: 0.55 })

  // float body — a squat cone-can buoy
  const hull = mesh(new THREE.CylinderGeometry(0.62 * S, 0.85 * S, 1.5 * S, 10), body)
  hull.position.y = 0.55 * S
  g.add(hull)
  // a paler waterline band
  const band = mesh(new THREE.CylinderGeometry(0.87 * S, 0.87 * S, 0.32 * S, 10), mat(0xf2ede2, { roughness: 0.7 }))
  band.position.y = 0.2 * S
  g.add(band)
  // skeletal mast
  const mast = mesh(new THREE.CylinderGeometry(0.08 * S, 0.08 * S, 1.4 * S, 6), mat(0x33373d))
  mast.position.y = 1.3 * S + 0.7 * S
  g.add(mast)
  // topmark: red = can (cylinder), green = cone (nun)
  const topmark = isRed
    ? mesh(new THREE.CylinderGeometry(0.34 * S, 0.34 * S, 0.6 * S, 8), body)
    : mesh(new THREE.ConeGeometry(0.36 * S, 0.66 * S, 8), body)
  topmark.position.y = 2.0 * S + 0.35 * S
  g.add(topmark)

  // blinking lamp at the top — HDR emissive that blooms; opacity animated to blink.
  const lampHi = isRed ? new THREE.Color(3.0, 0.5, 0.4) : new THREE.Color(0.4, 3.0, 0.7)
  const lampMat = new THREE.MeshBasicMaterial({
    color: lampHi,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
  const lamp = mesh(new THREE.SphereGeometry(0.26 * S, 10, 7), lampMat)
  lamp.position.y = 2.0 * S + 0.78 * S // total top ≈ 2.78S ≈ 18u (< 30)
  g.add(lamp)

  return {
    group: g,
    inst: { lampMat, baseHi: 1, phase: rand() * Math.PI * 2, rate: 0.9 + rand() * 0.8 },
  }
}

// ── system ───────────────────────────────────────────────────────────────────
export function createBeaconsSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'beacons'

  // animated registries (filled in init, played in update — zero alloc)
  const beams: Array<{ pivot: THREE.Group; spin: number }> = []
  const buoys: BuoyInstance[] = []

  let elapsed = 0

  return {
    name: 'beacons',
    init(ctx: GameContext) {
      const R = ctx.planet.radius // crust / water surface (640)
      const Rcore = R - FLAT_CORE_GAP // green core shell (634)
      // beams sit on the core shell (emerge from the blue), bases lifted a hair.
      const Rbeam = Rcore + beamRingExtra
      // buoys float on the blue crust water surface.
      const Rbuoy = R

      for (let si = 0; si < SITES.length; si++) {
        const site = SITES[si]
        if (!site.hasTown) continue // navigation lights only ring the inhabited towns

        const up = new THREE.Vector3(site.dir[0], site.dir[1], site.dir[2]).normalize()
        // Build a tangent basis at this site so we can offset ring positions in the
        // local surface plane, then re-anchor each piece to its own shell radius.
        const tanA = new THREE.Vector3()
        const tanB = new THREE.Vector3()
        // pick a reference not parallel to up
        const ref = Math.abs(up.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : UP_Y
        tanA.crossVectors(ref, up).normalize()
        tanB.crossVectors(up, tanA).normalize()

        // per-site deterministic rng (independent of frame rng)
        let seed = (si * 2654435761) >>> 0
        const rng = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0
          return seed / 4294967296
        }

        // angular radius (in radians) of the ring around the island, just inside
        // the island edge. site.radius is a world-unit landmass radius; convert to
        // an angle on the sphere and pull it in a touch so lights hug the coast.
        const edgeAng = (site.radius / R) * 0.96

        // ── ROTATING BEAMS: 3 short beacon posts spaced around the coast ────────
        const nBeams = 3
        for (let i = 0; i < nBeams; i++) {
          const a = (i / nBeams) * Math.PI * 2 + rng() * 0.6
          // beam ring slightly inside the buoy ring (on the coastal land edge)
          const ang = edgeAng * 0.82
          // direction on the sphere = rotate `up` by `ang` around axis in tangent plane
          const dir = new THREE.Vector3()
          const axis = new THREE.Vector3()
            .addScaledVector(tanA, Math.cos(a))
            .addScaledVector(tanB, Math.sin(a))
            .normalize()
          dir.copy(up).applyAxisAngle(axis, ang).normalize()

          const post = buildBeamPost(rng)
          post.group.position.copy(dir).multiplyScalar(Rbeam)
          post.group.quaternion.setFromUnitVectors(UP_Y, dir)
          // give each beam a random starting sweep angle + direction for variety
          post.pivot.rotation.y = rng() * Math.PI * 2
          const spin = post.spin * (rng() < 0.5 ? 1 : -1)
          post.group.name = `beacon.beam.${site.name}.${i}`
          root.add(post.group)
          beams.push({ pivot: post.pivot, spin })
        }

        // ── BUOYS: a ring of alternating red/green channel markers on the water ──
        const nBuoys = 8
        for (let i = 0; i < nBuoys; i++) {
          const a = (i / nBuoys) * Math.PI * 2 + 0.18
          const isRed = i % 2 === 0
          // slight per-buoy jitter outward so the ring isn't a perfect circle
          const ang = edgeAng * (1.02 + (rng() - 0.5) * 0.08)
          const dir = new THREE.Vector3()
          const axis = new THREE.Vector3()
            .addScaledVector(tanA, Math.cos(a))
            .addScaledVector(tanB, Math.sin(a))
            .normalize()
          dir.copy(up).applyAxisAngle(axis, ang).normalize()

          const { group, inst } = buildBuoy(isRed, rng)
          group.position.copy(dir).multiplyScalar(Rbuoy)
          group.quaternion.setFromUnitVectors(UP_Y, dir)
          group.name = `beacon.buoy.${site.name}.${i}`
          root.add(group)
          buoys.push(inst)
        }
      }

      ctx.scene.add(root)
    },

    update(dt: number) {
      elapsed += dt
      // sweep every beam (frame-rate independent scalar add — zero allocation)
      for (let i = 0; i < beams.length; i++) {
        const b = beams[i]
        b.pivot.rotation.y += b.spin * dt
      }
      // blink every buoy lamp: a sharp-ish flash via a raised-sine of time.
      for (let i = 0; i < buoys.length; i++) {
        const bu = buoys[i]
        // s in [0,1], peaked → most of the cycle dim with a bright flash
        const s = 0.5 + 0.5 * Math.sin(elapsed * bu.rate * Math.PI * 2 + bu.phase)
        const flash = s * s * s // sharpen into a blink
        bu.lampMat.opacity = 0.12 + 0.88 * flash
      }
    },

    dispose() {
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.geometry?.dispose()
          const mm = m.material
          if (Array.isArray(mm)) for (const x of mm) x.dispose()
          else mm?.dispose()
        }
      })
      root.parent?.remove(root)
      root.clear()
      beams.length = 0
      buoys.length = 0
    },
  }
}
