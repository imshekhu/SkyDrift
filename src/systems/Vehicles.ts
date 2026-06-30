import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'
import { damp } from '../plane/flight'
import { WORLD_SCALE } from '../world/WorldConfig'

/**
 * Vehicles — the player's rideable, swappable low-poly craft.
 *
 * Two hand-built rigs are parented UNDER ctx.player.obj (the flight Object3D),
 * sharing its orientation (nose = local +Z, up = local +Y):
 *
 *   • BIPLANE  — coral fuselage with a rounded cowl, stacked double wings on
 *                yellow struts, bracing wires, a tail fin + rudder, two fat
 *                wheels on legs, and a NACA-style spinning propeller. The prop
 *                is built as crisp blades PLUS a translucent "motion-blur" disc
 *                that fades in with rpm so it reads as a real spinning disc on
 *                a boost without ever stuttering. Spin tracks live engine speed.
 *
 *   • CARPET   — a magic flying carpet: a subdivided cloth plane that RIPPLES
 *                via a cheap per-vertex sine wave (recomputed in place, no
 *                realloc), with the woven border riding the same wave so the
 *                trim never tears off the cloth; four corner TASSELS that sway
 *                AND bob; a row of FRINGE knots along the tail; and a long
 *                trailing RIBBON streamer that ripples out behind the nose.
 *
 * The player starts on the biplane. The Progression system emits 'vehicleUnlock'
 * { id, label } at milestone levels; ids we know map to a rig (notably 'carpet').
 * Any flight-craft unlock makes the carpet available. Press V to cycle through
 * unlocked rigs.
 *
 * JUICE: switching plays a quick "swap pop" — the outgoing rig shrink-spins
 * away and the incoming rig springs in with an over-shoot scale and a barrel
 * twirl, plus a one-shot UNLOCK PREVIEW CARD slides up in the HUD showing the
 * craft's name when a new rig becomes available.
 *
 * Mobile-perf: each rig is a handful of flat-shaded Lambert meshes; the carpet
 * cloth + ribbon are the only animated geometry (small grids, waved with
 * pre-allocated scratch only). update() allocates nothing. No lights added.
 */

// Warm pastel accents not in PAL (authored sRGB, color-managed like PAL) for the
// carpet cloth so the coral plane body stays the world's only pure-coral object.
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const CARPET_CLOTH = srgb(0xc77dff) // soft orchid — the flying carpet's weave
const CARPET_WEAVE = srgb(0x9d6fe0) // a darker orchid for the inner panel motif
const CARPET_TRIM = srgb(0xffd166) // shares the plane's yellow for cohesion
const TASSEL = srgb(0xfff2d6) // warm cream (PAL.sun-adjacent) fringe
const PROP_HUB = srgb(0x3a3a44) // dark spinner hub
const WIRE = srgb(0x6b6b78) // slate bracing wires / wheel legs

// Carpet cloth grid resolution (segments). Small = cheap to wave each frame.
const CLOTH_SEGS_X = 8
const CLOTH_SEGS_Z = 12
const CLOTH_W = 3.2
const CLOTH_L = 4.6
const RIBBON_SEGS = 16
const RIBBON_LEN = 9
const RIBBON_W = 0.5
const FRINGE_COUNT = 7 // little knots dangling off the carpet's tail edge

interface Rig {
  id: string
  label: string
  group: THREE.Group
  unlocked: boolean
}

// ----- module-scope scratch: ZERO per-frame allocation in update() ----------
const _v = new THREE.Vector3()

export function createVehiclesSystem(): GameSystem {
  // Disposables captured at init.
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  const rigs: Rig[] = []

  // Live animation handles (assigned in init, read in update). No realloc.
  let propBlades: THREE.Object3D | null = null // crisp blade cross
  let propBlur: THREE.Mesh | null = null // translucent motion-blur disc
  let propBlurMat: THREE.MeshLambertMaterial | null = null
  let gatlingCluster: THREE.Object3D | null = null // 6-barrel cluster, spins on fire
  let gatlingSpin = 0 // accumulated rotation angle (rad)
  let gatlingSpool = 0 // 0..1 smoothed firing level (drives spin rate)
  let carpetCloth: THREE.Mesh | null = null
  let carpetClothBase: Float32Array | null = null // rest positions (x,z); y is waved
  let carpetTrim: THREE.Object3D | null = null // border frame; rides the cloth tilt
  let ribbon: THREE.Mesh | null = null
  let ribbonBase: Float32Array | null = null // rest positions along the streamer
  const tassels: THREE.Object3D[] = [] // four corner fringes that sway + bob
  const tasselRest: number[] = [] // each tassel's base local-Z (for phase offset)
  const fringe: THREE.Object3D[] = [] // tail-edge knots that swing
  const fringeRest: number[] = [] // each knot's base local-X (for phase offset)

  let activeIndex = 0
  let propSpin = 0 // accumulated propeller angle (radians)
  let propRpm01 = 0 // smoothed normalized rpm → drives blur opacity
  let swapT = 1 // swap-animation clock (1 = settled). Drives the pop.
  let swapFrom = -1 // rig index spinning OUT during a swap (-1 = none)
  let ctxRef: GameContext | null = null
  let offUnlock: (() => void) | null = null
  let onKey: ((e: KeyboardEvent) => void) | null = null

  // Unlock preview card (HUD). Built lazily on first unlock, reused after.
  let card: HTMLDivElement | null = null
  let cardTimer = 0 // window.setTimeout handle for auto-hide

  // ----- build helpers (init-time only) -----------------------------------

  const lambert = (color: THREE.Color): THREE.MeshLambertMaterial => {
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true })
    materials.push(m)
    return m
  }

  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => {
    geometries.push(geo)
    return new THREE.Mesh(geo, mat)
  }

  /** Build the coral biplane rig. Captures prop handles for spin in update(). */
  function buildBiplane(): THREE.Group {
    const g = new THREE.Group()
    g.name = 'vehicle.biplane'

    const body = lambert(PAL.planeBody) // coral — the signature plane color
    const wingMat = lambert(PAL.planeWing) // yellow
    const strutMat = lambert(CARPET_TRIM) // yellow struts/accents
    const propMat = lambert(PAL.planeWing)
    const hubMat = lambert(PROP_HUB)
    const wireMat = lambert(WIRE)

    // Fuselage — a stout box, nose tapering forward (+Z).
    const fuselage = mesh(new THREE.BoxGeometry(0.66, 0.68, 2.9), body)
    g.add(fuselage)

    // Rounded engine cowl up front (a short coral cylinder) so the nose reads.
    const cowlGeo = new THREE.CylinderGeometry(0.42, 0.36, 0.55, 12)
    cowlGeo.rotateX(Math.PI / 2)
    geometries.push(cowlGeo)
    const cowl = new THREE.Mesh(cowlGeo, body)
    cowl.position.z = 1.6
    g.add(cowl)

    const nose = mesh(new THREE.ConeGeometry(0.4, 1.0, 10), body)
    nose.rotation.x = Math.PI / 2 // cone points up by default → aim +Z
    nose.position.z = 2.05
    g.add(nose)

    const cockpit = mesh(new THREE.SphereGeometry(0.3, 10, 8), lambert(PAL.gem))
    cockpit.scale.set(1, 0.8, 1.2)
    cockpit.position.set(0, 0.42, -0.1)
    g.add(cockpit)

    // Gatling cannon — underslung minigun beneath the fuselage. Pylon → housing
    // → spinning multi-barrel cluster. Cluster is captured for per-frame spin.
    const pylonGeo = new THREE.BoxGeometry(0.1, 0.22, 0.16)
    geometries.push(pylonGeo)
    const pylon = new THREE.Mesh(pylonGeo, wireMat)
    pylon.position.set(0, -0.44, 0.5)
    g.add(pylon)
    const housingGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.42, 10)
    housingGeo.rotateX(Math.PI / 2)
    geometries.push(housingGeo)
    const housing = new THREE.Mesh(housingGeo, hubMat)
    housing.position.set(0, -0.55, 0.5)
    g.add(housing)
    // Rotating barrel cluster: 6 mini barrels arranged in a ring around +Z.
    const cluster = new THREE.Group()
    cluster.position.set(0, -0.55, 0.95)
    g.add(cluster)
    gatlingCluster = cluster
    const miniBarrelGeo = new THREE.CylinderGeometry(0.028, 0.033, 0.7, 6)
    miniBarrelGeo.rotateX(Math.PI / 2)
    geometries.push(miniBarrelGeo)
    const NB = 6
    const ringR = 0.085
    for (let i = 0; i < NB; i++) {
      const a = (i / NB) * Math.PI * 2
      const mb = new THREE.Mesh(miniBarrelGeo, hubMat)
      mb.position.set(Math.cos(a) * ringR, Math.sin(a) * ringR, 0)
      cluster.add(mb)
    }
    // Front face plate that holds the barrels (cosmetic disc).
    const facePlateGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.04, 10)
    facePlateGeo.rotateX(Math.PI / 2)
    geometries.push(facePlateGeo)
    const facePlate = new THREE.Mesh(facePlateGeo, body)
    facePlate.position.z = 0.35
    cluster.add(facePlate)

    // Double wings (the biplane silhouette): a lower and an upper plank.
    const lowerWing = mesh(new THREE.BoxGeometry(5.0, 0.14, 1.05), wingMat)
    lowerWing.position.set(0, -0.05, 0.15)
    g.add(lowerWing)

    const upperWing = mesh(new THREE.BoxGeometry(5.2, 0.14, 1.1), wingMat)
    upperWing.position.set(0, 0.95, 0.1)
    g.add(upperWing)

    // Coral wingtip caps on the upper wing so the tips pick up the brand color.
    const tipGeo = new THREE.BoxGeometry(0.26, 0.15, 1.05)
    geometries.push(tipGeo)
    for (const x of [-2.55, 2.55]) {
      const tip = new THREE.Mesh(tipGeo, body)
      tip.position.set(x, 0.95, 0.1)
      g.add(tip)
    }

    // Wing struts connecting the two planks (slim posts) + thin bracing wires
    // that cross between them for a hand-built, period-correct look.
    const strutGeo = new THREE.BoxGeometry(0.1, 1.0, 0.1)
    geometries.push(strutGeo)
    const wireGeo = new THREE.BoxGeometry(0.035, 1.32, 0.035)
    geometries.push(wireGeo)
    for (const x of [-1.5, 1.5]) {
      const s = new THREE.Mesh(strutGeo, strutMat)
      s.position.set(x, 0.45, 0.12)
      g.add(s)
      // crossed bracing wires (two thin posts, tilted opposite ways)
      for (const sign of [-1, 1]) {
        const w = new THREE.Mesh(wireGeo, wireMat)
        w.position.set(x, 0.45, 0.12)
        w.rotation.x = sign * 0.42
        g.add(w)
      }
    }

    // Tail: horizontal stabiliser + vertical fin + a coral rudder accent.
    const tail = mesh(new THREE.BoxGeometry(1.9, 0.12, 0.66), wingMat)
    tail.position.set(0, 0.05, -1.4)
    g.add(tail)

    const fin = mesh(new THREE.BoxGeometry(0.12, 0.82, 0.66), wingMat)
    fin.position.set(0, 0.5, -1.4)
    g.add(fin)

    const rudder = mesh(new THREE.BoxGeometry(0.13, 0.5, 0.34), body)
    rudder.position.set(0, 0.42, -1.66)
    g.add(rudder)

    // Wheels — two fat dark discs on slim legs under the lower wing.
    const wheelGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.14, 12)
    geometries.push(wheelGeo)
    const hubCapGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.16, 8)
    geometries.push(hubCapGeo)
    const legGeo = new THREE.BoxGeometry(0.08, 0.55, 0.08)
    geometries.push(legGeo)
    const wheelMat = lambert(PROP_HUB)
    for (const x of [-0.9, 0.9]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat)
      w.rotation.z = Math.PI / 2 // axle along X
      w.position.set(x, -0.72, 0.2)
      g.add(w)
      const cap = new THREE.Mesh(hubCapGeo, strutMat) // yellow hubcap pop
      cap.rotation.z = Math.PI / 2
      cap.position.set(x, -0.72, 0.2)
      g.add(cap)
      const leg = new THREE.Mesh(legGeo, wireMat)
      leg.position.set(x, -0.45, 0.2)
      leg.rotation.x = 0.12
      g.add(leg)
    }

    // --- Propeller: crisp blades + a motion-blur disc -----------------------
    // The whole prop assembly is a group at the nose. Its blades and blur disc
    // share one spin axis (local +Z, the nose direction). We bake the blade
    // geometry flat in the XY plane and spin the group about Z each frame.
    const propRoot = new THREE.Group()
    propRoot.position.z = 2.6
    g.add(propRoot)

    // Two crossed blades (a four-blade look) — thin coral-yellow paddles.
    const bladeGeo = new THREE.BoxGeometry(0.16, 1.9, 0.05)
    geometries.push(bladeGeo)
    const blades = new THREE.Group()
    for (const rot of [0, Math.PI / 2]) {
      const b = new THREE.Mesh(bladeGeo, propMat)
      b.rotation.z = rot
      blades.add(b)
    }
    propRoot.add(blades)
    propBlades = blades

    // Motion-blur disc: a thin translucent cylinder face, opacity ramps with
    // rpm in update(). Starts invisible at idle, fades to a soft smear on boost.
    const blurGeo = new THREE.CylinderGeometry(0.98, 0.98, 0.02, 18)
    blurGeo.rotateX(Math.PI / 2) // face forward (+Z)
    geometries.push(blurGeo)
    propBlurMat = new THREE.MeshLambertMaterial({
      color: PAL.planeWing,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      flatShading: true,
    })
    materials.push(propBlurMat)
    propBlur = new THREE.Mesh(blurGeo, propBlurMat)
    propRoot.add(propBlur)

    // Spinner hub + nose cone at the very tip.
    const hub = mesh(new THREE.SphereGeometry(0.17, 10, 8), hubMat)
    propRoot.add(hub)
    const spinnerGeo = new THREE.ConeGeometry(0.16, 0.34, 10)
    spinnerGeo.rotateX(Math.PI / 2)
    geometries.push(spinnerGeo)
    const spinner = new THREE.Mesh(spinnerGeo, hubMat)
    spinner.position.z = 0.18
    propRoot.add(spinner)

    return g
  }

  /** Build the magic carpet rig. Captures cloth/ribbon/tassels for update(). */
  function buildCarpet(): THREE.Group {
    const g = new THREE.Group()
    g.name = 'vehicle.carpet'

    const clothMat = lambert(CARPET_CLOTH)
    clothMat.side = THREE.DoubleSide // a flat carpet seen from above and below
    const trimMat = lambert(CARPET_TRIM)
    trimMat.side = THREE.DoubleSide
    const weaveMat = lambert(CARPET_WEAVE)
    weaveMat.side = THREE.DoubleSide
    const coralMat = lambert(PAL.planeBody) // coral motif keeps brand cohesion
    const tasselMat = lambert(TASSEL)
    const ribbonMat = lambert(PAL.planeBody) // a coral streamer trailing behind
    ribbonMat.side = THREE.DoubleSide

    // --- the cloth: a flat grid lying in the XZ plane, waved each frame ---
    const cloth = new THREE.PlaneGeometry(CLOTH_W, CLOTH_L, CLOTH_SEGS_X, CLOTH_SEGS_Z)
    cloth.rotateX(-Math.PI / 2) // plane faces up; spans X (width) and Z (length)
    geometries.push(cloth)
    const clothMesh = new THREE.Mesh(cloth, clothMat)
    clothMesh.position.y = 0.1
    g.add(clothMesh)
    carpetCloth = clothMesh
    // snapshot the rest positions so the wave is computed from a stable base.
    {
      const pos = cloth.attributes.position as THREE.BufferAttribute
      carpetClothBase = new Float32Array(pos.array.length)
      carpetClothBase.set(pos.array as Float32Array)
    }

    // Inner woven panel (a slightly smaller, darker orchid plane) for depth.
    const inner = new THREE.PlaneGeometry(CLOTH_W * 0.62, CLOTH_L * 0.7)
    inner.rotateX(-Math.PI / 2)
    geometries.push(inner)
    const innerMesh = new THREE.Mesh(inner, weaveMat)
    innerMesh.position.y = 0.13
    clothMesh.add(innerMesh) // child of cloth → drifts with the cloth's tilt

    // Decorative trim border + a coral diamond motif, grouped so the WHOLE
    // border can tilt with the cloth's leading edge (set in update) instead of
    // floating rigid above a rippling rug.
    const trim = new THREE.Group()
    g.add(trim)
    carpetTrim = trim

    const frameThick = 0.18
    const frameGeoLong = new THREE.BoxGeometry(CLOTH_W * 0.98, 0.06, frameThick)
    const frameGeoSide = new THREE.BoxGeometry(frameThick, 0.06, CLOTH_L * 0.98)
    geometries.push(frameGeoLong, frameGeoSide)
    const fF = new THREE.Mesh(frameGeoLong, trimMat)
    fF.position.set(0, 0.16, CLOTH_L / 2 - frameThick / 2)
    const fB = new THREE.Mesh(frameGeoLong, trimMat)
    fB.position.set(0, 0.16, -CLOTH_L / 2 + frameThick / 2)
    const fL = new THREE.Mesh(frameGeoSide, trimMat)
    fL.position.set(-CLOTH_W / 2 + frameThick / 2, 0.16, 0)
    const fR = new THREE.Mesh(frameGeoSide, trimMat)
    fR.position.set(CLOTH_W / 2 - frameThick / 2, 0.16, 0)
    trim.add(fF, fB, fL, fR)

    const diamond = mesh(new THREE.OctahedronGeometry(0.5, 0), coralMat)
    diamond.scale.set(1, 0.18, 1.6)
    diamond.position.y = 0.17
    trim.add(diamond)
    // four little coral corner studs framing the diamond
    const studGeo = new THREE.OctahedronGeometry(0.16, 0)
    geometries.push(studGeo)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const stud = new THREE.Mesh(studGeo, coralMat)
        stud.scale.set(1, 0.3, 1)
        stud.position.set(sx * CLOTH_W * 0.32, 0.17, sz * CLOTH_L * 0.34)
        trim.add(stud)
      }
    }

    // --- four corner tassels: little cones that sway + bob (animated) ---
    const tasselGeo = new THREE.ConeGeometry(0.12, 0.6, 6)
    geometries.push(tasselGeo)
    const knotGeo = new THREE.SphereGeometry(0.1, 6, 5)
    geometries.push(knotGeo)
    const hx = CLOTH_W / 2 - 0.1
    const hz = CLOTH_L / 2 - 0.1
    for (const [sx, sz] of [
      [-hx, hz],
      [hx, hz],
      [-hx, -hz],
      [hx, -hz],
    ] as Array<[number, number]>) {
      const pivot = new THREE.Group() // pivot at the corner so the cone swings
      pivot.position.set(sx, 0.06, sz)
      const t = new THREE.Mesh(tasselGeo, tasselMat)
      t.position.y = -0.34
      t.rotation.x = Math.PI // point downward
      pivot.add(t)
      const knot = new THREE.Mesh(knotGeo, trimMat) // yellow bead at the top
      pivot.add(knot)
      g.add(pivot)
      tassels.push(pivot)
      tasselRest.push(sz) // phase the sway by along-length position
    }

    // --- a row of fringe knots dangling off the tail edge (-Z) ---
    const fringeGeo = new THREE.ConeGeometry(0.07, 0.34, 5)
    geometries.push(fringeGeo)
    for (let i = 0; i < FRINGE_COUNT; i++) {
      const fx = (i / (FRINGE_COUNT - 1) - 0.5) * (CLOTH_W - 0.4)
      const pivot = new THREE.Group()
      pivot.position.set(fx, 0.04, -CLOTH_L / 2 + 0.05)
      const f = new THREE.Mesh(fringeGeo, tasselMat)
      f.position.y = -0.2
      f.rotation.x = Math.PI
      pivot.add(f)
      g.add(pivot)
      fringe.push(pivot)
      fringeRest.push(fx)
    }

    // --- trailing ribbon: a long thin strip streaming out behind (-Z) ---
    const rib = new THREE.PlaneGeometry(RIBBON_W, RIBBON_LEN, 1, RIBBON_SEGS)
    rib.rotateX(-Math.PI / 2) // lie flat, length along Z
    rib.translate(0, 0, -RIBBON_LEN / 2 - CLOTH_L / 2 + 0.2) // start at carpet's tail
    geometries.push(rib)
    const ribMesh = new THREE.Mesh(rib, ribbonMat)
    ribMesh.position.y = 0.05
    g.add(ribMesh)
    ribbon = ribMesh
    {
      const pos = rib.attributes.position as THREE.BufferAttribute
      ribbonBase = new Float32Array(pos.array.length)
      ribbonBase.set(pos.array as Float32Array)
    }

    return g
  }

  // ----- per-frame cloth/ribbon waving (zero allocation) ------------------

  function waveCloth(time: number, amp: number): void {
    if (!carpetCloth || !carpetClothBase) return
    const geo = carpetCloth.geometry as THREE.BufferGeometry
    const pos = geo.attributes.position as THREE.BufferAttribute
    const base = carpetClothBase
    const arr = pos.array as Float32Array
    const n = pos.count
    let frontY = 0 // y at the leading edge centerline (for trim tilt)
    let backY = 0
    for (let i = 0; i < n; i++) {
      const bx = base[i * 3]
      const bz = base[i * 3 + 2]
      // two crossed travelling waves → a gentle flutter; tail flaps more (z<0).
      const tailGain = 0.5 + (0.5 - bz / CLOTH_L) // more flap toward the back
      const y =
        Math.sin(bz * 1.8 + time * 5.0) * 0.09 * amp * tailGain +
        Math.sin(bx * 2.4 + time * 3.3) * 0.05 * amp +
        // a slow body-roll so the whole rug banks side to side as it flies
        Math.sin(bx * 0.9 + time * 1.4) * 0.04 * amp
      arr[i * 3] = bx
      arr[i * 3 + 1] = y
      arr[i * 3 + 2] = bz
      if (bx === 0) {
        if (bz > CLOTH_L * 0.45) frontY = y
        else if (bz < -CLOTH_L * 0.45) backY = y
      }
    }
    pos.needsUpdate = true
    // flatShading:true → shader derives face normals from position derivatives (dFdx/dFdy).
    // The normal attribute is not used; calling computeVertexNormals() every frame is wasteful.
    // Tilt the rigid trim frame to follow the cloth's nose-to-tail slope so the
    // gold border rides the ripple instead of hovering flat above it.
    if (carpetTrim) carpetTrim.rotation.x = (backY - frontY) * 0.18
  }

  function waveRibbon(time: number, amp: number): void {
    if (!ribbon || !ribbonBase) return
    const geo = ribbon.geometry as THREE.BufferGeometry
    const pos = geo.attributes.position as THREE.BufferAttribute
    const base = ribbonBase
    const arr = pos.array as Float32Array
    const n = pos.count
    for (let i = 0; i < n; i++) {
      const bx = base[i * 3]
      const bz = base[i * 3 + 2]
      // distance back along the streamer (bz is negative going aft).
      const along = -bz // grows toward the free end
      const fade = Math.min(1, along / RIBBON_LEN)
      const y = Math.sin(along * 1.4 - time * 6.0) * 0.55 * amp * fade
      const x = bx + Math.sin(along * 1.1 - time * 4.5) * 0.35 * amp * fade
      arr[i * 3] = x
      arr[i * 3 + 1] = y
      arr[i * 3 + 2] = bz
    }
    pos.needsUpdate = true
    // flatShading:true → face normals are derived in-shader; no CPU recompute needed.
  }

  // ----- vehicle switching -------------------------------------------------

  function showActive(): void {
    for (let i = 0; i < rigs.length; i++) {
      rigs[i].group.visible = i === activeIndex
    }
  }

  // smoothstep + a small overshoot bump → a springy "pop" on swap-in.
  const smooth = (t: number) => t * t * (3 - 2 * t)
  const overshoot = (t: number) => {
    // 0→1 with a gentle >1 bump near the end, settling back to 1.
    const s = smooth(THREE.MathUtils.clamp(t, 0, 1))
    return s + Math.sin(s * Math.PI) * 0.18 * (1 - s)
  }

  function applySwapPose(): void {
    // Drives the swap-in (active rig) and swap-out (previous rig) transforms.
    const inG = rigs[activeIndex]?.group
    if (inG) {
      const k = overshoot(swapT) // ~1.18 bump → settles to 1
      inG.scale.setScalar(0.2 + 0.8 * k + (1 - smooth(swapT)) * 0.0)
      inG.rotation.z = (1 - smooth(swapT)) * Math.PI * 2 // one twirl as it lands
    }
    if (swapFrom >= 0 && swapFrom < rigs.length) {
      const outG = rigs[swapFrom].group
      const s = 1 - smooth(swapT)
      outG.scale.setScalar(Math.max(0.001, s))
      outG.rotation.z = -smooth(swapT) * Math.PI * 1.4
    }
  }

  function cycleVehicle(): void {
    if (!ctxRef) return
    // advance to the next UNLOCKED rig after the current one.
    const start = activeIndex
    let idx = activeIndex
    for (let step = 0; step < rigs.length; step++) {
      idx = (idx + 1) % rigs.length
      if (rigs[idx].unlocked) break
    }
    if (idx === start) {
      ctxRef.hud.toast('No other craft unlocked yet', 1600)
      return
    }
    // kick off the swap animation: old rig spins out, new one springs in.
    swapFrom = activeIndex
    activeIndex = idx
    swapT = 0
    rigs[activeIndex].group.visible = true
    rigs[swapFrom].group.visible = true
    applySwapPose()
    ctxRef.hud.toast(`Now flying: ${rigs[activeIndex].label}`, 2200)
    ctxRef.audio.play('select', { rate: 1.1 })
    ctxRef.events.emit('boost', { active: false }) // settle any FOV/meter state
  }

  // ----- unlock preview card (HUD) ----------------------------------------

  function ensureCard(): HTMLDivElement {
    if (card) return card
    const el = document.createElement('div')
    el.style.cssText = [
      'position:absolute',
      'left:50%',
      'bottom:18%',
      'transform:translate(-50%,16px)',
      'pointer-events:none',
      'padding:10px 18px',
      'border-radius:14px',
      'font:600 15px/1.25 ui-rounded,system-ui,sans-serif',
      'text-align:center',
      'color:#3a2b2b',
      'background:linear-gradient(180deg,rgba(255,248,236,0.96),rgba(255,233,205,0.96))',
      'box-shadow:0 8px 24px rgba(120,80,60,0.28),inset 0 1px 0 rgba(255,255,255,0.7)',
      'border:1.5px solid rgba(255,209,102,0.9)',
      'opacity:0',
      'transition:transform .42s cubic-bezier(.2,1.2,.3,1),opacity .42s ease',
      'will-change:transform,opacity',
      'z-index:5',
    ].join(';')
    ctxRef?.hud.root.appendChild(el)
    card = el
    return el
  }

  function showUnlockCard(label: string): void {
    const el = ensureCard()
    el.innerHTML =
      `<div style="font-size:11px;letter-spacing:.14em;opacity:.7;text-transform:uppercase">New Craft Unlocked</div>` +
      `<div style="font-size:18px;margin-top:2px">${label}</div>` +
      `<div style="font-size:11px;opacity:.7;margin-top:3px">press V to fly it</div>`
    // pop in
    requestAnimationFrame(() => {
      el.style.opacity = '1'
      el.style.transform = 'translate(-50%,0)'
    })
    if (cardTimer) clearTimeout(cardTimer)
    cardTimer = window.setTimeout(() => {
      el.style.opacity = '0'
      el.style.transform = 'translate(-50%,16px)'
    }, 3000)
  }

  function unlockById(id: string): void {
    for (const r of rigs) {
      if (r.id === id && !r.unlocked) {
        r.unlocked = true
        ctxRef?.hud.toast(`New craft ready: ${r.label} — press V`, 2600)
        ctxRef?.audio.play('unlock', { rate: 1.0 })
        showUnlockCard(r.label)
      }
    }
  }

  return {
    name: 'vehicles',

    init(ctx: GameContext) {
      ctxRef = ctx

      // Build both rigs and parent them under the player flight object.
      const biplane = buildBiplane()
      const carpet = buildCarpet()
      // Scale the craft to the world: the rigs are authored at radius-100 size,
      // and the swap-pop animates each rig's OWN .scale to settle at 1 — so we
      // scale a parent HOLDER (× WORLD_SCALE) rather than fight that animation.
      const rigHolder = new THREE.Group()
      rigHolder.name = 'rig-holder'
      rigHolder.scale.setScalar(WORLD_SCALE * 0.9) // plane at 90% of its authored size
      ctx.player.obj.add(rigHolder)
      rigHolder.add(biplane)
      rigHolder.add(carpet)

      rigs.push({ id: 'biplane', label: 'Coral Biplane', group: biplane, unlocked: true })
      rigs.push({ id: 'carpet', label: 'Magic Carpet', group: carpet, unlocked: false })

      activeIndex = 0
      swapT = 1
      swapFrom = -1
      showActive()

      // Listen for milestone unlocks from the Progression system.
      offUnlock = ctx.events.on('vehicleUnlock', (p?: any) => {
        const id = p && typeof p.id === 'string' ? (p.id as string) : ''
        // Map known progression ids onto our rigs. 'carpet' is a direct match;
        // any flight-craft unlock also makes the carpet available to try.
        if (id === 'carpet') unlockById('carpet')
        else if (id === 'glider' || id === 'seaplane') unlockById('carpet')
      })

      // Press V to cycle through unlocked craft.
      onKey = (e: KeyboardEvent) => {
        if (e.code === 'KeyV') cycleVehicle()
      }
      addEventListener('keydown', onKey)
    },

    update(dt: number, ctx: GameContext) {
      const speed = ctx.player.flight.speed
      const speed01 = THREE.MathUtils.clamp(speed / 86, 0, 1.4)

      // --- swap "pop" animation (runs briefly after a V press) ---
      if (swapT < 1) {
        swapT = Math.min(1, swapT + dt * 3.2) // ~0.31s pop
        applySwapPose()
        if (swapT >= 1) {
          // settle: hide the outgoing rig, normalize transforms.
          if (swapFrom >= 0 && swapFrom < rigs.length) {
            const outG = rigs[swapFrom].group
            outG.visible = false
            outG.scale.setScalar(1)
            outG.rotation.z = 0
          }
          const inG = rigs[activeIndex]?.group
          if (inG) {
            inG.scale.setScalar(1)
            inG.rotation.z = 0
          }
          swapFrom = -1
        }
      }

      const activeId = rigs[activeIndex]?.id

      // Spin the gatling cluster: spools up when firing, idle drift when not.
      if (activeId === 'biplane' && gatlingCluster) {
        const target = ctx.input.firing ? 1 : 0
        gatlingSpool += (target - gatlingSpool) * damp(7, dt)
        gatlingSpin += (2 + 28 * gatlingSpool) * dt
        if (gatlingSpin > Math.PI * 2) gatlingSpin -= Math.PI * 2
        gatlingCluster.rotation.z = gatlingSpin
      }

      // Spin the biplane propeller + ramp the motion-blur disc with rpm.
      if (activeId === 'biplane' && propBlades) {
        propSpin += (24 + speed01 * 44) * dt // rad/s, faster on boost
        if (propSpin > Math.PI * 2) propSpin -= Math.PI * 2
        propBlades.rotation.z = propSpin // blades spin true about nose axis (+Z)
        // smoothly ramp blur opacity with normalized rpm: idle = crisp blades,
        // cruise/boost = a soft translucent disc smear. dt-invariant blend.
        const target = THREE.MathUtils.clamp((speed - 30) / 56, 0, 1)
        propRpm01 += (target - propRpm01) * damp(6, dt)
        if (propBlur && propBlurMat) {
          propBlurMat.opacity = 0.42 * propRpm01
          propBlur.rotation.z = -propSpin * 0.5 // counter-smear for shimmer
          // fade the crisp blades out a touch as the blur takes over
          propBlades.scale.setScalar(1 - 0.12 * propRpm01)
        }
      }

      // Ripple the carpet only while it's active (skip the cost otherwise).
      if (activeId === 'carpet') {
        const t = ctx.elapsed()
        const flutter = 0.7 + 0.6 * THREE.MathUtils.clamp(speed / 86, 0, 1)
        waveCloth(t, flutter)
        waveRibbon(t, flutter)
        // Sway + bob the corner tassels with a smoothed, dt-invariant target.
        const k = damp(8, dt)
        for (let i = 0; i < tassels.length; i++) {
          const phase = tasselRest[i] * 0.8
          const targetX = Math.sin(t * 4.0 + phase) * 0.4 * flutter
          const targetZ = Math.cos(t * 3.2 + phase) * 0.22 * flutter
          const tsl = tassels[i]
          tsl.rotation.z += (targetX - tsl.rotation.z) * k
          tsl.rotation.x += (targetZ - tsl.rotation.x) * k
          // gentle vertical bob so the beads bounce on the flutter
          tsl.position.y += (0.06 + Math.sin(t * 5.0 + phase) * 0.05 * flutter - tsl.position.y) * k
        }
        // Tail fringe swings on its own faster phase for a busy, lively edge.
        for (let i = 0; i < fringe.length; i++) {
          const phase = fringeRest[i] * 1.3
          const fx = Math.sin(t * 5.5 + phase) * 0.5 * flutter
          fringe[i].rotation.x = fx
        }
      }
    },

    dispose() {
      if (offUnlock) {
        offUnlock()
        offUnlock = null
      }
      if (onKey) {
        removeEventListener('keydown', onKey)
        onKey = null
      }
      if (cardTimer) {
        clearTimeout(cardTimer)
        cardTimer = 0
      }
      if (card) {
        card.parentNode?.removeChild(card)
        card = null
      }
      for (const r of rigs) {
        r.group.parent?.remove(r.group)
      }
      rigs.length = 0
      for (const g of geometries) g.dispose()
      geometries.length = 0
      for (const m of materials) m.dispose()
      materials.length = 0
      propBlades = null
      propBlur = null
      propBlurMat = null
      gatlingCluster = null
      carpetCloth = null
      carpetClothBase = null
      carpetTrim = null
      ribbon = null
      ribbonBase = null
      tassels.length = 0
      tasselRest.length = 0
      fringe.length = 0
      fringeRest.length = 0
      ctxRef = null
      // keep module scratch (_v) — it's reusable across instances
      void _v
    },
  }
}
