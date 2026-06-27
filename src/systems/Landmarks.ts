import * as THREE from 'three'
import { alignToSurface } from '../world/surface'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'
import { damp } from '../plane/flight'
import { WORLD_SCALE } from '../world/WorldConfig'

/**
 * Landmarks — ~6 distinctive, hand-built low-poly structures dotted around the
 * globe. Each sits at a fixed, seeded surface position and is oriented radially
 * (local +Y = surface normal). They are readable silhouettes meant to act as the
 * targets for the "selfie" quest.
 *
 * Quest integration: instead of (mis)using a typed event, we publish a plain
 * registry on the shared context — `(ctx as any).landmarks` — an array of
 * { id, name, label, position, dir, selfieRadius }. The selfie quest reads it.
 *
 * Polish in this pass:
 *  - Richer, more charming models: lighthouse with a SWEEPING beam, tiered
 *    pagoda with upturned eaves + lanterns, a shaggy elder tree with blossoms,
 *    a robed guardian on a stepped plinth, a stone arch with keystone + steps,
 *    and a windmill with latticed sails + a balcony gallery.
 *  - A soft GLOW HALO per landmark (additive ground ring + lifted aura) that
 *    breathes gently and BLOOMS BRIGHTER as the plane flies near — a friendly
 *    "you found me" cue that also helps line up the selfie.
 *
 * Perf: every landmark is assembled from a handful of shared low-poly geometries
 * with a tiny palette of MeshLambertMaterials (cheap, behaves with ≤3 lights).
 * Halos use additive MeshBasicMaterial (unlit, no light budget cost). update()
 * spins the windmill, rotates the beam, pulses the lamp and drives proximity
 * glow with ZERO per-frame allocation (all math via module-scoped temporaries).
 */

export interface LandmarkInfo {
  id: string
  name: string
  /** short human label for HUD / quest toast */
  label: string
  /** world-space anchor at the structure base, slightly raised for framing */
  position: THREE.Vector3
  /** unit surface direction this landmark sits on */
  dir: THREE.Vector3
  /** how close (world units) the plane must get for a valid selfie */
  selfieRadius: number
}

// ----- module-scoped temporaries: zero per-frame allocation -----
const _dir = new THREE.Vector3()
const _up = new THREE.Vector3()
const _tangent = new THREE.Vector3()
const _bitangent = new THREE.Vector3()
const _basis = new THREE.Matrix4()
const _refA = new THREE.Vector3(0, 1, 0)
const _refB = new THREE.Vector3(1, 0, 0)
const _playerPos = new THREE.Vector3()

// Cozy pastel-dusk supporting palette (sRGB), authored to sit beside PAL.
const c = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const COL = {
  stoneLight: c(0xeae2d0), // warm off-white masonry
  stoneDark: c(0xc8bfa8),
  roofRed: c(0xd9776b), // muted terracotta (distinct from the coral PLANE)
  roofTeal: c(0x6fb3a8),
  wood: c(0x9c6f4e),
  woodDark: c(0x7a5740),
  gold: PAL.planeWing, // reuse the cohesive yellow for accents
  beacon: c(0xfff0b8), // soft warm glow for the lighthouse lamp
  beamGlow: c(0xfff4cf), // pale gold beam shaft
  trunk: c(0x8a6243),
  leafA: PAL.tree,
  leafB: c(0x57a86b),
  blossom: c(0xf6c0cf), // soft pink for the elder tree
  bronze: c(0x9fae8d),
  sail: c(0xf3ede0),
  lantern: c(0xffcf7a),
  haloWarm: c(0xfff0c8), // gentle gold proximity aura
} as const

interface SpinTarget {
  obj: THREE.Object3D
  axis: 'x' | 'y' | 'z'
  speed: number // rad/s about the chosen local axis
}

interface PulseTarget {
  mat: THREE.MeshLambertMaterial
  base: number // base emissive intensity
  amp: number
  rate: number // pulses/sec (radians/sec into sin)
  phase: number
}

// A proximity halo: a ground ring + a lifted aura quad that breathe softly and
// bloom brighter as the plane approaches. World position is the landmark anchor.
interface HaloTarget {
  ring: THREE.Mesh
  aura: THREE.Mesh
  ringMat: THREE.MeshBasicMaterial
  auraMat: THREE.MeshBasicMaterial
  pos: THREE.Vector3 // world-space landmark anchor
  near: number // distance at which glow is at full bloom
  far: number // distance at which glow fades out
  baseScale: number // resting scale of the ground ring
  glow: number // smoothed 0..1 proximity factor
}

export function createLandmarksSystem(): GameSystem {
  // Shared resources, disposed on teardown.
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  let group: THREE.Group | null = null

  const spinners: SpinTarget[] = []
  const pulses: PulseTarget[] = []
  const halos: HaloTarget[] = []
  const infos: LandmarkInfo[] = []

  // shared halo geometries (one ring + one quad, reused per landmark)
  let haloRingGeo: THREE.RingGeometry | null = null
  let haloQuadGeo: THREE.PlaneGeometry | null = null

  // small geometry cache so repeated primitives are shared
  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g)
    return g
  }
  const mat = (color: THREE.Color, opts?: { flat?: boolean; emissive?: THREE.Color }) => {
    const m = new THREE.MeshLambertMaterial({
      color,
      flatShading: opts?.flat ?? true,
    })
    if (opts?.emissive) m.emissive.copy(opts.emissive)
    materials.push(m)
    return m
  }
  // unlit additive material for glows/beams — costs nothing against the light budget
  const glowMat = (color: THREE.Color, opacity: number) => {
    const m = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    materials.push(m)
    return m
  }

  // Orient a child so its local +Y points "outward" (radially up at the base),
  // i.e. it stands on the surface like a building. dir is a unit surface normal.
  const standOn = (o: THREE.Object3D, dir: THREE.Vector3) => {
    // local +Y → the surface normal (radial-up here) via the shared
    // setFromUnitVectors() form, so every building/prop aligns identically.
    alignToSurface(o, dir)
  }

  // tiny lantern helper: a warm glowing cube on a string, used for charm.
  const addLantern = (parent: THREE.Object3D, lanternGeo: THREE.BufferGeometry, lanternMat: THREE.Material, x: number, y: number, z: number) => {
    const l = new THREE.Mesh(lanternGeo, lanternMat)
    l.position.set(x, y, z)
    parent.add(l)
  }

  // ---------------- builders (each returns a THREE.Group, +Y is up, base at y=0) ----------------

  const buildLighthouse = (): THREE.Group => {
    const g = new THREE.Group()
    const baseMat = mat(COL.stoneLight)
    const stripeMat = mat(COL.roofRed)

    // rocky footing so it doesn't look planted in mid-air
    const footing = track(new THREE.CylinderGeometry(3.6, 4.2, 1.4, 7))
    const mf = new THREE.Mesh(footing, mat(COL.stoneDark))
    mf.position.y = 0.7
    mf.rotation.y = 0.3
    g.add(mf)

    // tapered tower as stacked tubes (cheap, readable), now with a candy stripe
    const seg0 = track(new THREE.CylinderGeometry(2.4, 3.2, 5, 10))
    const seg1 = track(new THREE.CylinderGeometry(1.8, 2.4, 5, 10))
    const seg2 = track(new THREE.CylinderGeometry(1.4, 1.8, 4, 10))
    const m0 = new THREE.Mesh(seg0, baseMat)
    m0.position.y = 2.9
    const m1 = new THREE.Mesh(seg1, stripeMat)
    m1.position.y = 7.9
    const m2 = new THREE.Mesh(seg2, baseMat)
    m2.position.y = 12.4
    g.add(m0, m1, m2)

    // a couple of little windows for character
    const winGeo = track(new THREE.BoxGeometry(0.5, 0.8, 0.4))
    const winMat = mat(COL.beacon, { emissive: COL.beacon })
    winMat.emissiveIntensity = 0.35
    const w0 = new THREE.Mesh(winGeo, winMat)
    w0.position.set(0, 5.0, 2.55)
    const w1 = new THREE.Mesh(winGeo, winMat)
    w1.position.set(0, 9.4, 2.1)
    g.add(w0, w1)

    // lamp gallery + railing
    const gallery = track(new THREE.CylinderGeometry(2.0, 2.0, 0.6, 10))
    const mg = new THREE.Mesh(gallery, mat(COL.stoneDark))
    mg.position.y = 14.6
    g.add(mg)
    const railGeo = track(new THREE.TorusGeometry(2.0, 0.12, 5, 12))
    const mrail = new THREE.Mesh(railGeo, mat(COL.woodDark))
    mrail.position.y = 15.2
    mrail.rotation.x = Math.PI / 2
    g.add(mrail)

    // glowing lamp room
    const lampMat = mat(COL.beacon, { emissive: COL.beacon })
    lampMat.emissiveIntensity = 0.6
    const lamp = track(new THREE.CylinderGeometry(1.3, 1.3, 1.8, 10))
    const ml = new THREE.Mesh(lamp, lampMat)
    ml.position.y = 15.9
    g.add(ml)
    pulses.push({ mat: lampMat, base: 0.6, amp: 0.45, rate: 2.2, phase: 0 })

    // ROTATING BEAM: a long, soft additive wedge that sweeps around the lamp.
    // Built once, parented to a spinner group at the lamp height.
    const beamPivot = new THREE.Group()
    beamPivot.position.y = 15.9
    g.add(beamPivot)
    // a thin tapered cone laid on its side = a shaft of light pointing +X
    const beamGeo = track(new THREE.ConeGeometry(2.2, 22, 4, 1, true))
    const beamMat = glowMat(COL.beamGlow, 0.18)
    const beam = new THREE.Mesh(beamGeo, beamMat)
    beam.rotation.z = -Math.PI / 2 // point the cone tip outward along +X
    beam.position.x = 11
    beamPivot.add(beam)
    // a faint second beam opposite, so the sweep reads from both sides
    const beam2 = new THREE.Mesh(beamGeo, beamMat)
    beam2.rotation.z = Math.PI / 2
    beam2.position.x = -11
    beamPivot.add(beam2)
    spinners.push({ obj: beamPivot, axis: 'y', speed: 0.9 })

    const roof = track(new THREE.ConeGeometry(1.7, 1.8, 10))
    const mr = new THREE.Mesh(roof, mat(COL.roofRed))
    mr.position.y = 17.7
    g.add(mr)
    // tiny finial ball
    const finial = track(new THREE.IcosahedronGeometry(0.35, 0))
    const mfin = new THREE.Mesh(finial, mat(COL.gold))
    mfin.position.y = 18.8
    g.add(mfin)
    return g
  }

  const buildPagoda = (): THREE.Group => {
    const g = new THREE.Group()
    const bodyMat = mat(COL.stoneLight)
    const roofMat = mat(COL.roofTeal)
    const pillarMat = mat(COL.woodDark)
    const lanternMat = mat(COL.lantern, { emissive: COL.lantern })
    lanternMat.emissiveIntensity = 0.5
    const lanternGeo = track(new THREE.BoxGeometry(0.6, 0.8, 0.6))

    // shared eave-corner ornament (an upturned tip) reused on every roof
    const tipGeo = track(new THREE.ConeGeometry(0.28, 1.1, 4))

    let y = 0
    let r = 4
    // three diminishing tiers, each = body + flared cone roof + upturned eaves
    for (let i = 0; i < 3; i++) {
      const bodyH = 3 - i * 0.4
      const body = track(new THREE.CylinderGeometry(r * 0.7, r * 0.72, bodyH, 4))
      const mb = new THREE.Mesh(body, bodyMat)
      mb.position.y = y + bodyH / 2
      mb.rotation.y = Math.PI / 4
      g.add(mb)
      y += bodyH

      const roof = track(new THREE.ConeGeometry(r, 1.6, 4))
      const mr = new THREE.Mesh(roof, roofMat)
      mr.position.y = y + 0.8
      mr.rotation.y = Math.PI / 4
      g.add(mr)

      // four upturned eave tips for that pagoda silhouette
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4
        const tip = new THREE.Mesh(tipGeo, roofMat)
        tip.position.set(Math.cos(a) * (r * 0.95), y + 0.55, Math.sin(a) * (r * 0.95))
        tip.rotation.z = Math.cos(a) * 0.5
        tip.rotation.x = -Math.sin(a) * 0.5
        g.add(tip)
      }

      // a warm lantern hung under each tier's eave (front face)
      addLantern(g, lanternGeo, lanternMat, 0, y + 0.1, r * 0.85)
      pulses.push({ mat: lanternMat, base: 0.45, amp: 0.25, rate: 1.5 + i * 0.3, phase: i * 1.3 })

      y += 1.0
      r *= 0.72
    }
    // golden finial stack
    const ring = track(new THREE.TorusGeometry(0.45, 0.12, 5, 8))
    const mring = new THREE.Mesh(ring, mat(COL.gold))
    mring.position.y = y + 0.4
    mring.rotation.x = Math.PI / 2
    g.add(mring)
    const spire = track(new THREE.ConeGeometry(0.4, 2.4, 6))
    const ms = new THREE.Mesh(spire, mat(COL.gold))
    ms.position.y = y + 1.6
    g.add(ms)

    // four corner pillars on the ground tier
    const pillar = track(new THREE.CylinderGeometry(0.25, 0.25, 3, 5))
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4
      const mp = new THREE.Mesh(pillar, pillarMat)
      mp.position.set(Math.cos(a) * 2.6, 1.5, Math.sin(a) * 2.6)
      g.add(mp)
    }
    return g
  }

  const buildGiantTree = (): THREE.Group => {
    const g = new THREE.Group()
    const trunkMat = mat(COL.trunk)
    const leafA = mat(COL.leafA)
    const leafB = mat(COL.leafB)
    const blossomMat = mat(COL.blossom)

    // gnarled root flare at the base
    const rootGeo = track(new THREE.ConeGeometry(1.0, 2.4, 5))
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2
      const root = new THREE.Mesh(rootGeo, trunkMat)
      root.position.set(Math.cos(a) * 2.0, 0.8, Math.sin(a) * 2.0)
      root.rotation.z = Math.cos(a) * 0.9
      root.rotation.x = -Math.sin(a) * 0.9
      g.add(root)
    }

    const trunk = track(new THREE.CylinderGeometry(1.4, 2.2, 11, 7))
    const mt = new THREE.Mesh(trunk, trunkMat)
    mt.position.y = 5.5
    g.add(mt)

    // a few branch stubs reaching out
    const branch = track(new THREE.CylinderGeometry(0.4, 0.7, 4, 5))
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4
      const mbr = new THREE.Mesh(branch, trunkMat)
      mbr.position.set(Math.cos(a) * 1.6, 7.6, Math.sin(a) * 1.6)
      mbr.rotation.z = Math.cos(a) * 0.6
      mbr.rotation.x = -Math.sin(a) * 0.6
      g.add(mbr)
    }

    // chunky low-poly canopy from a few icospheres — fuller and shaggier now
    const blobA = track(new THREE.IcosahedronGeometry(4.4, 0))
    const blobB = track(new THREE.IcosahedronGeometry(3.2, 0))
    const blobC = track(new THREE.IcosahedronGeometry(2.3, 0))
    const canopy: Array<[THREE.BufferGeometry, THREE.Material, number, number, number]> = [
      [blobA, leafA, 0, 12.8, 0],
      [blobB, leafB, 3.4, 11.4, 1.0],
      [blobB, leafA, -3.2, 11.7, -1.2],
      [blobB, leafB, 0.6, 11.1, 3.2],
      [blobB, leafA, -0.8, 11.4, -3.2],
      [blobC, leafB, 2.6, 14.4, -2.0],
      [blobC, leafA, -2.4, 14.1, 2.0],
    ]
    for (const [geo, m, x, yy, z] of canopy) {
      const mm = new THREE.Mesh(geo, m)
      mm.position.set(x, yy, z)
      g.add(mm)
    }

    // a scatter of pink blossoms dotting the canopy for cozy charm
    const blossomGeo = track(new THREE.IcosahedronGeometry(0.5, 0))
    const blossomSpots: Array<[number, number, number]> = [
      [3.6, 13.2, 1.4],
      [-3.4, 12.8, -1.0],
      [1.2, 15.0, 2.6],
      [-1.6, 14.8, -2.4],
      [0.0, 16.2, 0.4],
      [2.2, 12.0, -3.0],
    ]
    for (const [x, yy, z] of blossomSpots) {
      const mm = new THREE.Mesh(blossomGeo, blossomMat)
      mm.position.set(x, yy, z)
      g.add(mm)
    }
    return g
  }

  const buildStatue = (): THREE.Group => {
    const g = new THREE.Group()
    const stoneMat = mat(COL.bronze)
    const plinthMat = mat(COL.stoneDark)
    const plaqueMat = mat(COL.gold)

    // tiered, stepped plinth
    const p0 = track(new THREE.BoxGeometry(6.4, 1.0, 6.4))
    const p1 = track(new THREE.BoxGeometry(5.0, 1.0, 5.0))
    const p2 = track(new THREE.BoxGeometry(3.8, 1.0, 3.8))
    const mp0 = new THREE.Mesh(p0, plinthMat)
    mp0.position.y = 0.5
    const mp1 = new THREE.Mesh(p1, plinthMat)
    mp1.position.y = 1.5
    const mp2 = new THREE.Mesh(p2, plinthMat)
    mp2.position.y = 2.5
    g.add(mp0, mp1, mp2)

    // little golden plaque on the front of the plinth
    const plaque = track(new THREE.BoxGeometry(1.6, 0.7, 0.15))
    const mpl = new THREE.Mesh(plaque, plaqueMat)
    mpl.position.set(0, 1.5, 2.55)
    g.add(mpl)

    // abstract robed figure: robe (tapered), torso, head, one raised arm, a cape
    const robe = track(new THREE.CylinderGeometry(1.2, 2.0, 6, 7))
    const mrobe = new THREE.Mesh(robe, stoneMat)
    mrobe.position.y = 6.0
    g.add(mrobe)

    const torso = track(new THREE.CylinderGeometry(1.4, 1.2, 2.4, 7))
    const mtor = new THREE.Mesh(torso, stoneMat)
    mtor.position.y = 9.4
    g.add(mtor)

    // a swept-back cape (flat box) for heroic silhouette
    const cape = track(new THREE.BoxGeometry(2.6, 5.0, 0.3))
    const mcape = new THREE.Mesh(cape, plinthMat)
    mcape.position.set(0, 7.6, -1.3)
    mcape.rotation.x = 0.18
    g.add(mcape)

    const head = track(new THREE.IcosahedronGeometry(1.0, 0))
    const mhead = new THREE.Mesh(head, stoneMat)
    mhead.position.y = 11.2
    g.add(mhead)

    const arm = track(new THREE.CylinderGeometry(0.35, 0.45, 4, 5))
    const marm = new THREE.Mesh(arm, stoneMat)
    marm.position.set(1.5, 10.4, 0)
    marm.rotation.z = -0.9
    g.add(marm)

    // a small golden orb held aloft — a glowing beacon-y accent that pulses
    const orbMat = mat(COL.gold, { emissive: COL.gold })
    orbMat.emissiveIntensity = 0.4
    const orb = track(new THREE.IcosahedronGeometry(0.75, 0))
    const morb = new THREE.Mesh(orb, orbMat)
    morb.position.set(2.9, 12.2, 0)
    g.add(morb)
    pulses.push({ mat: orbMat, base: 0.45, amp: 0.4, rate: 1.8, phase: 2.0 })
    return g
  }

  const buildArch = (): THREE.Group => {
    const g = new THREE.Group()
    const stoneMat = mat(COL.stoneLight)
    const capMat = mat(COL.roofRed)
    const stepMat = mat(COL.stoneDark)

    // a couple of broad steps at the base
    const step0 = track(new THREE.BoxGeometry(13, 0.8, 5))
    const step1 = track(new THREE.BoxGeometry(11, 0.8, 4))
    const ms0 = new THREE.Mesh(step0, stepMat)
    ms0.position.y = 0.4
    const ms1 = new THREE.Mesh(step1, stepMat)
    ms1.position.y = 1.1
    g.add(ms0, ms1)

    // two legs standing on the steps
    const leg = track(new THREE.BoxGeometry(1.8, 8.4, 1.8))
    const lL = new THREE.Mesh(leg, stoneMat)
    lL.position.set(-4, 5.7, 0)
    const lR = new THREE.Mesh(leg, stoneMat)
    lR.position.set(4, 5.7, 0)
    g.add(lL, lR)

    // curved span approximated by rotated voussoirs (finer, smoother arc now)
    const voussoir = track(new THREE.BoxGeometry(1.9, 1.7, 1.9))
    const spanSteps = 8
    for (let i = 0; i <= spanSteps; i++) {
      const t = i / spanSteps
      const a = Math.PI * (1 - t) // 180deg -> 0
      const rx = Math.cos(a) * 4
      const ry = 9.9 + Math.sin(a) * 3.3
      const mv = new THREE.Mesh(voussoir, i === Math.round(spanSteps / 2) ? capMat : stoneMat)
      mv.position.set(rx, ry, 0)
      mv.rotation.z = a - Math.PI / 2
      g.add(mv)
    }

    // decorative cap stone + a small gold orb finial on top
    const cap = track(new THREE.BoxGeometry(4.2, 1.2, 2.8))
    const mc = new THREE.Mesh(cap, capMat)
    mc.position.set(0, 13.8, 0)
    g.add(mc)
    const finial = track(new THREE.IcosahedronGeometry(0.6, 0))
    const mfin = new THREE.Mesh(finial, mat(COL.gold))
    mfin.position.set(0, 14.9, 0)
    g.add(mfin)
    return g
  }

  const buildWindmill = (): THREE.Group => {
    const g = new THREE.Group()
    const bodyMat = mat(COL.stoneLight)
    const capMat = mat(COL.roofTeal)
    const sailMat = mat(COL.sail)
    const woodMat = mat(COL.wood)

    // tapered tower
    const tower = track(new THREE.CylinderGeometry(2.0, 3.0, 9, 10))
    const mt = new THREE.Mesh(tower, bodyMat)
    mt.position.y = 4.5
    g.add(mt)

    // a balcony gallery ring around the upper tower
    const balcony = track(new THREE.TorusGeometry(2.3, 0.18, 5, 14))
    const mbal = new THREE.Mesh(balcony, woodMat)
    mbal.position.y = 7.4
    mbal.rotation.x = Math.PI / 2
    g.add(mbal)

    // a little door
    const doorGeo = track(new THREE.BoxGeometry(1.0, 1.8, 0.4))
    const mdoor = new THREE.Mesh(doorGeo, mat(COL.woodDark))
    mdoor.position.set(0, 1.4, 2.85)
    g.add(mdoor)

    // conical cap
    const cap = track(new THREE.ConeGeometry(2.4, 2.6, 10))
    const mc = new THREE.Mesh(cap, capMat)
    mc.position.y = 10.3
    g.add(mc)

    // rotor hub sits on the +Z face of the cap; blades spin about local +Z
    const rotor = new THREE.Group()
    rotor.position.set(0, 9.7, 2.7)
    g.add(rotor)

    const hub = track(new THREE.CylinderGeometry(0.55, 0.55, 0.9, 8))
    const mh = new THREE.Mesh(hub, woodMat)
    mh.rotation.x = Math.PI / 2
    rotor.add(mh)

    // latticed sails: a long arm + a sail panel + two cross-slats per blade
    const armGeo = track(new THREE.BoxGeometry(0.4, 6.8, 0.3))
    const sailGeo = track(new THREE.BoxGeometry(1.9, 4.2, 0.12))
    const slatGeo = track(new THREE.BoxGeometry(2.0, 0.16, 0.18))
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Group()
      const arm = new THREE.Mesh(armGeo, woodMat)
      arm.position.y = 3.1
      const sail = new THREE.Mesh(sailGeo, sailMat)
      sail.position.set(0.95, 3.3, 0.08)
      const slat0 = new THREE.Mesh(slatGeo, woodMat)
      slat0.position.set(0.95, 2.3, 0.12)
      const slat1 = new THREE.Mesh(slatGeo, woodMat)
      slat1.position.set(0.95, 4.3, 0.12)
      blade.add(arm, sail, slat0, slat1)
      blade.rotation.z = (i / 4) * Math.PI * 2
      rotor.add(blade)
    }
    spinners.push({ obj: rotor, axis: 'z', speed: 0.8 })
    return g
  }

  // ---------------- proximity glow halo ----------------
  // Build a halo (ground ring + lifted aura quad) anchored at a landmark and
  // register it for per-frame proximity driving. Returns the parent group so the
  // caller can place it on the surface like the structures.
  const buildHalo = (radius: number): THREE.Group => {
    const g = new THREE.Group()
    if (!haloRingGeo) haloRingGeo = track(new THREE.RingGeometry(0.86, 1.0, 40)) as THREE.RingGeometry
    if (!haloQuadGeo) haloQuadGeo = track(new THREE.PlaneGeometry(1, 1)) as THREE.PlaneGeometry

    const baseScale = radius * 0.92
    const ringMat = glowMat(COL.haloWarm, 0.0)
    const ring = new THREE.Mesh(haloRingGeo, ringMat)
    ring.rotation.x = -Math.PI / 2 // lie flat on the ground
    ring.position.y = 0.15
    ring.scale.setScalar(baseScale)
    g.add(ring)

    const auraMat = glowMat(COL.haloWarm, 0.0)
    const aura = new THREE.Mesh(haloQuadGeo, auraMat)
    // a soft camera-facing glow lifted to roughly mid-height of the structure
    aura.position.y = radius * 0.42
    aura.scale.setScalar(radius * 1.15)
    g.add(aura)

    halos.push({
      ring,
      aura,
      ringMat,
      auraMat,
      pos: new THREE.Vector3(), // filled in once placed (world anchor)
      near: radius * 0.9,
      far: radius * 2.6,
      baseScale,
      glow: 0,
    })
    return g
  }

  // landmark definitions: id, name, label, builder, selfie radius
  const defs: Array<{
    id: string
    name: string
    label: string
    build: () => THREE.Group
    radius: number
  }> = [
    { id: 'lighthouse', name: 'Lighthouse', label: 'Old Lighthouse', build: buildLighthouse, radius: 26 * WORLD_SCALE },
    { id: 'pagoda', name: 'Pagoda', label: 'Sky Pagoda', build: buildPagoda, radius: 24 * WORLD_SCALE },
    { id: 'giant-tree', name: 'Giant Tree', label: 'Elder Tree', build: buildGiantTree, radius: 26 * WORLD_SCALE },
    { id: 'statue', name: 'Statue', label: 'The Guardian', build: buildStatue, radius: 24 * WORLD_SCALE },
    { id: 'arch', name: 'Arch', label: 'Traveler’s Arch', build: buildArch, radius: 24 * WORLD_SCALE },
    { id: 'windmill', name: 'Windmill', label: 'Breeze Mill', build: buildWindmill, radius: 24 * WORLD_SCALE },
  ]

  // deterministic spread of unit directions over the sphere using the seeded RNG.
  const pickDir = (ctx: GameContext, out: THREE.Vector3) => {
    const u = ctx.rand()
    const v = ctx.rand()
    const z = 1 - 2 * u // [-1,1]
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const phi = 2 * Math.PI * v
    out.set(r * Math.cos(phi), z, r * Math.sin(phi)).normalize()
  }

  return {
    name: 'landmarks',

    init(ctx: GameContext) {
      group = new THREE.Group()
      group.name = 'landmarks'

      // keep landmarks apart: reject directions too close to already-placed ones.
      const placed: THREE.Vector3[] = []

      for (let di = 0; di < defs.length; di++) {
        const def = defs[di]
        // find a reasonably spread direction (few tries, deterministic)
        const chosen = new THREE.Vector3()
        let best = -1
        for (let attempt = 0; attempt < 8; attempt++) {
          pickDir(ctx, _dir)
          let minDot = 1
          for (const p of placed) minDot = Math.min(minDot, p.dot(_dir))
          // lower dot = farther apart; pick the farthest candidate
          const spread = 1 - minDot
          if (spread > best) {
            best = spread
            chosen.copy(_dir)
          }
          if (placed.length === 0) break
        }
        placed.push(chosen.clone())

        const node = def.build()
        // place its base on the surface, oriented radially
        const basePos = ctx.planet.surfacePoint(chosen, 0)
        node.position.copy(basePos)
        standOn(node, chosen)
        // scale the whole structure up so it isn't tiny on the huge planet
        node.scale.setScalar(WORLD_SCALE)
        group.add(node)

        // proximity halo: placed at the base, oriented like the structure
        const haloNode = buildHalo(def.radius)
        haloNode.position.copy(basePos)
        standOn(haloNode, chosen)
        group.add(haloNode)
        // the halo we just pushed is the last entry; anchor it to the world pos
        halos[halos.length - 1].pos.copy(haloNode.position)

        // quest anchor: a touch above the base for nicer framing
        const anchor = ctx.planet.surfacePoint(chosen, 6)
        infos.push({
          id: def.id,
          name: def.name,
          label: def.label,
          position: anchor.clone(),
          dir: chosen.clone(),
          selfieRadius: def.radius,
        })
      }

      ctx.scene.add(group)

      // publish the registry for the selfie quest (and anyone else who wants it).
      ;(ctx as any).landmarks = infos
    },

    update(dt: number, ctx: GameContext) {
      const t = ctx.elapsed()

      // spin windmill blades + sweep the lighthouse beam (frame-rate independent)
      for (let i = 0; i < spinners.length; i++) {
        const s = spinners[i]
        s.obj.rotation[s.axis] += s.speed * dt
      }

      // pulse emissive accents (lamp / lanterns / orbs) — smooth, allocation-free
      for (let i = 0; i < pulses.length; i++) {
        const p = pulses[i]
        const k = p.base + p.amp * (0.5 + 0.5 * Math.sin(t * p.rate + p.phase))
        // ease toward target so resume-from-background doesn't snap
        p.mat.emissiveIntensity += (k - p.mat.emissiveIntensity) * damp(8, dt)
      }

      // proximity glow: bloom the halo as the plane nears each landmark, and keep
      // the lifted aura quad facing the camera. Zero allocation.
      if (halos.length) {
        _playerPos.copy(ctx.player.obj.position)
        const ease = damp(5, dt)
        const breathe = 0.85 + 0.15 * Math.sin(t * 1.6)
        for (let i = 0; i < halos.length; i++) {
          const h = halos[i]
          const dist = _playerPos.distanceTo(h.pos)
          // 1 when at/under `near`, 0 at/beyond `far`, smooth in between
          let target = (h.far - dist) / (h.far - h.near)
          target = target < 0 ? 0 : target > 1 ? 1 : target
          target = target * target * (3 - 2 * target) // smoothstep
          h.glow += (target - h.glow) * ease
          const g = h.glow * breathe
          h.ringMat.opacity = g * 0.55
          h.auraMat.opacity = g * 0.30
          // gentle scale bloom on the ground ring as you close in
          h.ring.scale.setScalar(h.baseScale * (0.96 + h.glow * 0.12))
          // keep the aura billboard facing the camera
          h.aura.quaternion.copy(ctx.camera.quaternion)
          // skip rendering entirely when fully faded (cheap micro-cull)
          const vis = g > 0.003
          h.ring.visible = vis
          h.aura.visible = vis
        }
      }
    },

    dispose() {
      if (group) {
        group.parent?.remove(group)
        group = null
      }
      for (const g of geometries) g.dispose()
      for (const m of materials) m.dispose()
      geometries.length = 0
      materials.length = 0
      spinners.length = 0
      pulses.length = 0
      halos.length = 0
      infos.length = 0
      haloRingGeo = null
      haloQuadGeo = null
    },
  }
}
