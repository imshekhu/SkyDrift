import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { DOME_RADIUS, CAMERA_FAR } from '../world/WorldConfig'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Cosmos: the space backdrop + celestial bodies.
//
//   • sky dome   — huge inverted gradient sphere, recentred on the camera
//   • starfield  — ~3000 Points, recentred on the camera, slow rotation + twinkle
//   • two moons  — real bodies orbiting the planet at origin (fly toward them)
//   • dwarf star — a second, bluish-white HDR sun with an additive glow halo
//   • planets    — two distant icospheres, one ringed, slowly orbiting
//   • satellites — four small craft skimming overhead with blinking red lights
//
// Backdrop pieces (dome, stars) ride the camera so they read as infinite.
// Orbiting bodies (moons, dwarf star, planets, satellites) are anchored to the
// world at the planet's origin and are kept inside CAMERA_FAR by construction.
// Zero allocation inside update(): all scratch lives at module scope.
// ─────────────────────────────────────────────────────────────────────────────

const col = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

// Vertical-gradient sky colors.
const ZENITH = col(0x0b1130) // deep indigo/navy overhead
const HORIZON = col(0x3b3d72) // soft twilight blue-violet at y=0

// ── module-scope scratch (no allocation in update) ────────────────────────────
const _cam = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _pos = new THREE.Vector3()

// A reusable orbit resolver: body at angle `a` on a circle of radius `r` whose
// plane is the XZ plane rotated by an inclination quaternion. Writes into `out`.
function orbit(out: THREE.Vector3, r: number, a: number, incl: THREE.Quaternion): THREE.Vector3 {
  out.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(incl)
  return out
}

interface Orbiter {
  obj: THREE.Object3D
  radius: number
  speed: number // rad/sec
  phase: number // starting angle
  incl: THREE.Quaternion
  spin: number // self-rotation rad/sec (0 = none)
}

export function createCosmosSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'cosmos'

  // disposal registries
  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []
  const tex: THREE.Texture[] = []
  const track = <T extends THREE.BufferGeometry>(g: T): T => (geos.push(g), g)
  const trackM = <T extends THREE.Material>(m: T): T => (mats.push(m), m)

  const std = (hex: number, opts: THREE.MeshStandardMaterialParameters = {}) =>
    trackM(new THREE.MeshStandardMaterial({ color: col(hex), flatShading: true, roughness: 0.9, metalness: 0, fog: false, ...opts }))

  let dome: THREE.Mesh | null = null
  let stars: THREE.Points | null = null
  let starMat: THREE.PointsMaterial | null = null

  const orbiters: Orbiter[] = []
  // satellite blink lights: {light, period, onFrac, phase}
  const blinkers: Array<{ light: THREE.Mesh; period: number; onFrac: number; phase: number }> = []

  let acc = 0 // own time accumulator (never read Math.random in update)

  // ── inclination helper: tilt the XZ orbit plane by `deg` about an axis ───────
  function inclination(deg: number, axX: number, axZ: number): THREE.Quaternion {
    const q = new THREE.Quaternion()
    _axis.set(axX, 0, axZ).normalize()
    q.setFromAxisAngle(_axis, THREE.MathUtils.degToRad(deg))
    return q
  }

  function addCraters(parent: THREE.Object3D, bodyR: number, n: number, rand: () => number, hex: number) {
    const m = std(hex, { roughness: 1 })
    for (let i = 0; i < n; i++) {
      const cr = new THREE.Mesh(track(new THREE.IcosahedronGeometry(bodyR * (0.12 + rand() * 0.14), 0)), m)
      // place on the surface, pushed slightly in so it reads as a pit/spot
      _pos
        .set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1)
        .normalize()
        .multiplyScalar(bodyR * 0.92)
      cr.position.copy(_pos)
      parent.add(cr)
    }
  }

  return {
    name: 'cosmos',

    init(ctx: GameContext) {
      const rand = ctx.rand

      // ── 1) SKY DOME — inverted gradient sphere, recentred on camera ──────────
      const domeGeo = track(new THREE.IcosahedronGeometry(DOME_RADIUS, 4))
      const dPos = domeGeo.attributes.position as THREE.BufferAttribute
      const dColors = new Float32Array(dPos.count * 3)
      const cTmp = new THREE.Color()
      for (let i = 0; i < dPos.count; i++) {
        // y in [-R..R] → t in [0..1], 1 = zenith
        const t = THREE.MathUtils.clamp((dPos.getY(i) / DOME_RADIUS) * 0.5 + 0.5, 0, 1)
        cTmp.copy(HORIZON).lerp(ZENITH, t * t) // bias darkness toward the top
        dColors[i * 3] = cTmp.r
        dColors[i * 3 + 1] = cTmp.g
        dColors[i * 3 + 2] = cTmp.b
      }
      domeGeo.setAttribute('color', new THREE.BufferAttribute(dColors, 3))
      const domeMat = trackM(
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          side: THREE.BackSide,
          fog: false,
          depthWrite: false,
        })
      )
      dome = new THREE.Mesh(domeGeo, domeMat)
      dome.name = 'cosmos.dome'
      dome.renderOrder = -10 // draw first, behind everything
      dome.frustumCulled = false
      root.add(dome)

      // we own the sky now
      ctx.scene.fog = null
      ctx.renderer.setClearColor(ZENITH, 1)

      // ── 2) STARFIELD — ~3000 Points on a sphere, recentred on camera ─────────
      const STAR_N = 3000
      const STAR_R = Math.min(2400, CAMERA_FAR - 200)
      const sPos = new Float32Array(STAR_N * 3)
      const sCol = new Float32Array(STAR_N * 3)
      const tint = new THREE.Color()
      for (let i = 0; i < STAR_N; i++) {
        // uniform on a sphere
        const u = rand() * 2 - 1
        const ang = rand() * Math.PI * 2
        const r2 = Math.sqrt(1 - u * u)
        sPos[i * 3] = Math.cos(ang) * r2 * STAR_R
        sPos[i * 3 + 1] = u * STAR_R
        sPos[i * 3 + 2] = Math.sin(ang) * r2 * STAR_R
        // tint: mostly white, some pale-blue / pale-yellow
        const pick = rand()
        if (pick < 0.6) tint.setRGB(1, 1, 1)
        else if (pick < 0.8) tint.setRGB(0.72, 0.82, 1) // pale blue
        else tint.setRGB(1, 0.95, 0.78) // pale yellow
        const b = 0.55 + rand() * 0.45
        sCol[i * 3] = tint.r * b
        sCol[i * 3 + 1] = tint.g * b
        sCol[i * 3 + 2] = tint.b * b
      }
      const starGeo = track(new THREE.BufferGeometry())
      starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3))
      starGeo.setAttribute('color', new THREE.BufferAttribute(sCol, 3))
      starMat = trackM(
        new THREE.PointsMaterial({
          size: 2.0,
          vertexColors: true,
          transparent: true,
          opacity: 1,
          depthWrite: false,
          fog: false,
          sizeAttenuation: false,
        })
      )
      stars = new THREE.Points(starGeo, starMat)
      stars.name = 'cosmos.stars'
      stars.renderOrder = -9
      stars.frustumCulled = false
      root.add(stars)

      // ── 3) TWO MOONS — real orbiting bodies (NOT camera-recentred) ───────────
      // Moon A: pale grey, big, inner-ish orbit on one inclined plane.
      const moonA = new THREE.Mesh(track(new THREE.IcosahedronGeometry(70, 2)), std(0xb9bcc4, { roughness: 0.95 }))
      moonA.name = 'cosmos.moonA'
      addCraters(moonA, 70, 6, rand, 0x9a9da6)
      root.add(moonA)
      orbiters.push({ obj: moonA, radius: 1150, speed: 0.045, phase: rand() * Math.PI * 2, incl: inclination(18, 1, 0.4), spin: 0.04 })

      // Moon B: smaller warm tan, outer orbit, different inclination + speed.
      const moonB = new THREE.Mesh(track(new THREE.IcosahedronGeometry(45, 2)), std(0xc9a878, { roughness: 0.95 }))
      moonB.name = 'cosmos.moonB'
      addCraters(moonB, 45, 5, rand, 0xa98a5e)
      root.add(moonB)
      orbiters.push({ obj: moonB, radius: 1500, speed: 0.062, phase: rand() * Math.PI * 2, incl: inclination(-32, 0.3, 1), spin: 0.06 })

      // ── 4) DWARF STAR — intense bluish-white HDR sun + additive glow halo ────
      const dwarf = new THREE.Group()
      dwarf.name = 'cosmos.dwarf'
      const dwarfCore = new THREE.Mesh(
        track(new THREE.IcosahedronGeometry(30, 2)),
        trackM(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.6, 3.2), toneMapped: false, fog: false }))
      )
      dwarf.add(dwarfCore)
      // additive glow halo: a bigger transparent additive sphere
      const dwarfHalo = new THREE.Mesh(
        track(new THREE.IcosahedronGeometry(64, 2)),
        trackM(
          new THREE.MeshBasicMaterial({
            color: new THREE.Color(0.6, 0.85, 1.3),
            toneMapped: false,
            transparent: true,
            opacity: 0.45,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: false,
            side: THREE.BackSide,
          })
        )
      )
      dwarf.add(dwarfHalo)
      root.add(dwarf)
      orbiters.push({ obj: dwarf, radius: 1800, speed: 0.012, phase: rand() * Math.PI * 2, incl: inclination(12, 0.6, 0.8), spin: 0 })

      // ── 5) PLANETS — two distant flat-shaded icospheres, one ringed ──────────
      // Keep radius <= 1900: camera is within ~760 of origin, 1900+760 < CAMERA_FAR.
      const planetA = new THREE.Mesh(track(new THREE.IcosahedronGeometry(110, 2)), std(0xc77b54, { roughness: 1 }))
      planetA.name = 'cosmos.planetA'
      // a tilted thin ring
      const ring = new THREE.Mesh(
        track(new THREE.RingGeometry(150, 230, 48, 1)),
        trackM(
          new THREE.MeshBasicMaterial({
            color: col(0xd9b98a),
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
            depthWrite: false,
            fog: false,
          })
        )
      )
      ring.rotation.x = Math.PI / 2 // flatten to the planet's equatorial plane
      ring.rotation.y = THREE.MathUtils.degToRad(25) // tilt ~25deg
      planetA.add(ring)
      root.add(planetA)
      orbiters.push({ obj: planetA, radius: 1750, speed: 0.018, phase: rand() * Math.PI * 2, incl: inclination(8, 1, 0.2), spin: 0.05 })

      const planetB = new THREE.Mesh(track(new THREE.IcosahedronGeometry(85, 2)), std(0x5a86b0, { roughness: 1 }))
      planetB.name = 'cosmos.planetB'
      root.add(planetB)
      orbiters.push({ obj: planetB, radius: 1880, speed: 0.014, phase: rand() * Math.PI * 2, incl: inclination(-22, 0.5, 1), spin: 0.04 })

      // ── 6) SATELLITES — four small craft skimming overhead (above cruise) ────
      const bodyMat = std(0xcacfd6, { roughness: 0.6, metalness: 0.2 })
      const panelMat = std(0x223a66, { roughness: 0.4, metalness: 0.3 })
      const SAT_N = 4
      for (let i = 0; i < SAT_N; i++) {
        const sat = new THREE.Group()
        sat.name = `cosmos.sat${i}`
        const body = new THREE.Mesh(track(new THREE.BoxGeometry(6, 6, 9)), bodyMat)
        sat.add(body)
        for (const sx of [-1, 1]) {
          const wing = new THREE.Mesh(track(new THREE.BoxGeometry(14, 0.4, 6)), panelMat)
          wing.position.x = sx * 11
          sat.add(wing)
        }
        // blinking red light on the nose
        const light = new THREE.Mesh(
          track(new THREE.SphereGeometry(1.3, 8, 6)),
          trackM(new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 0.2, 0.15), toneMapped: false, fog: false }))
        )
        light.position.z = 5.5
        sat.add(light)
        root.add(sat)

        const r = 770 + i * 28 // 770..854 — comfortably above cruise (704)
        orbiters.push({
          obj: sat,
          radius: r,
          speed: 0.16 + rand() * 0.06, // clearly moving
          phase: rand() * Math.PI * 2,
          incl: inclination(20 + i * 30, Math.cos(i), Math.sin(i)),
          spin: 0,
        })
        blinkers.push({ light, period: 0.7 + rand() * 0.5, onFrac: 0.4, phase: rand() })
      }

      ctx.scene.add(root)
    },

    update(dt: number, ctx: GameContext) {
      acc += dt

      // recenter backdrop on the camera so it reads as infinite
      ctx.camera.getWorldPosition(_cam)
      if (dome) dome.position.copy(_cam)
      if (stars) {
        stars.position.copy(_cam)
        stars.rotation.y += dt * 0.006 // slow drift
        // gentle global twinkle
        if (starMat) starMat.opacity = 0.85 + 0.15 * Math.sin(acc * 1.3)
      }

      // advance every orbiting body around the planet at origin
      for (let i = 0; i < orbiters.length; i++) {
        const o = orbiters[i]
        const a = o.phase + acc * o.speed
        orbit(_pos, o.radius, a, o.incl)
        o.obj.position.copy(_pos)
        if (o.spin !== 0) o.obj.rotateY(o.spin * dt)
      }

      // blink satellite lights (deterministic from accumulator)
      for (let i = 0; i < blinkers.length; i++) {
        const b = blinkers[i]
        const ph = ((acc / b.period) + b.phase) % 1
        const on = ph < b.onFrac
        b.light.visible = on
      }
    },

    dispose() {
      root.parent?.remove(root)
      for (const g of geos) g.dispose()
      for (const m of mats) m.dispose()
      for (const t of tex) t.dispose()
      geos.length = 0
      mats.length = 0
      tex.length = 0
      orbiters.length = 0
      blinkers.length = 0
      dome = null
      stars = null
      starMat = null
    },
  }
}
