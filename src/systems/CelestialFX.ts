import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { CAMERA_FAR } from '../world/WorldConfig'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — CelestialFX: a night-sky spectacle layered onto the Cosmos backdrop.
//
//   • AURORA   — 3 large wavy translucent curtains high in the sky. Vertex-waved
//                additive ribbons (emerald / teal / violet) that slowly undulate.
//   • METEORS  — a pool of ~10 shooting-star streaks: a bright HDR head + a fading
//                additive tail. They dart across the sky on a timer and recycle.
//   • COMET    — one slow comet (glowing head + long additive tail) drifting along
//                a great-circle arc across the dome.
//   • NEBULA   — a couple of faint additive glow patches (soft radial sprites) for
//                deep-sky colour.
//
// Everything is emissive / additive so the composer's bloom flares it. The whole
// rig is a single Group recentred on the CAMERA each frame (like the sky dome /
// starfield in Cosmos) so it reads as infinitely distant; all pieces sit well
// inside CAMERA_FAR by construction. No new THREE.js lights are created — pure
// MeshBasicMaterial({ toneMapped:false }) + additive Points/Sprites.
//
// Zero allocation inside update(): every scratch lives at module scope, and all
// randomness is pre-seeded into per-object phase tables in init() (update() never
// calls Math.random / ctx.rand). Includes a working dispose().
// ─────────────────────────────────────────────────────────────────────────────

// ── module-scope scratch (no allocation in update) ────────────────────────────
const _cam = new THREE.Vector3()
const _v = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

// Shell radius for the FX layer — comfortably inside the camera far plane, and
// further out than gameplay so it never intersects the world. (Recentred on the
// camera each frame, so this is a distance-from-camera, not a world radius.)
const FX_R = Math.min(2100, CAMERA_FAR - 350)

// HDR helper — values > 1 bloom; toneMapped:false keeps them out of AgX clamp.
const hdr = (r: number, g: number, b: number) => new THREE.Color(r, g, b)

// ── radial soft-glow sprite texture (shared by nebulae + comet/meteor heads) ──
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const x = c.getContext('2d')!
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0.0, 'rgba(255,255,255,1)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.65)')
  g.addColorStop(0.6, 'rgba(255,255,255,0.18)')
  g.addColorStop(1.0, 'rgba(255,255,255,0)')
  x.fillStyle = g
  x.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.needsUpdate = true
  return t
}

// ── AURORA curtain: a vertical ribbon mesh hung high in the sky, additive, with
// a top→bottom alpha fade baked into vertex colours and a per-vertex undulation
// driven in update() from base positions (zero alloc). ───────────────────────--
interface Curtain {
  mesh: THREE.Mesh
  base: Float32Array // base local vertex positions
  attr: THREE.BufferAttribute
  cols: number // columns of the lattice
  rows: number
  width: number
  height: number
  waveAmp: number
  waveFreq: number
  waveSpeed: number
  phase: number
  driftSpeed: number // slow yaw drift about world up
  yaw0: number
}

// ── METEOR: a head sprite + a thin tapered tail mesh, both additive. Flies along
// a straight chord across the sky, fades, then recycles after a random delay. ──
interface Meteor {
  group: THREE.Group
  head: THREE.Sprite
  tailMesh: THREE.Mesh
  tailBase: Float32Array
  tailAttr: THREE.BufferAttribute
  from: THREE.Vector3 // unit dir start
  to: THREE.Vector3 // unit dir end
  t: number // 0..1 progress along the streak
  speed: number // progress per second
  active: boolean
  delay: number // seconds until next launch
  delayBase: number
  len: number // streak head-to-tail length (world units on the shell)
  color: THREE.Color
  // re-seed table: precomputed candidate from/to pairs + timing (no rand in update)
  seedFrom: THREE.Vector3[]
  seedTo: THREE.Vector3[]
  seedIdx: number
}

export function createCelestialFXSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'celestialFX'
  root.frustumCulled = false
  root.renderOrder = -8 // after the dome/stars (-10/-9), before world geometry

  // disposal registries
  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []
  const texs: THREE.Texture[] = []
  const track = <T extends THREE.BufferGeometry>(g: T): T => (geos.push(g), g)
  const trackM = <T extends THREE.Material>(m: T): T => (mats.push(m), m)
  const trackT = <T extends THREE.Texture>(t: T): T => (texs.push(t), t)

  const curtains: Curtain[] = []
  const meteors: Meteor[] = []

  let comet: {
    group: THREE.Group
    from: THREE.Vector3
    to: THREE.Vector3
    t: number
    speed: number
    tailMesh: THREE.Mesh
    tailBase: Float32Array
    tailAttr: THREE.BufferAttribute
    len: number
  } | null = null

  const nebulae: THREE.Sprite[] = []

  let acc = 0 // own time accumulator — never read rand() in update()

  let glowTex: THREE.CanvasTexture | null = null

  // ── build one aurora curtain as a (cols × rows) lattice ribbon ───────────────
  function buildCurtain(
    rand: () => number,
    width: number,
    height: number,
    topColor: THREE.Color,
    botColor: THREE.Color
  ): Curtain {
    const cols = 24
    const rows = 6
    const nV = (cols + 1) * (rows + 1)
    const pos = new Float32Array(nV * 3)
    const colA = new Float32Array(nV * 3)
    // Local frame: ribbon spans X in [-w/2, w/2], rises in Y in [0, height].
    // Curve it gently around the sky on a shallow arc so it wraps overhead.
    const arc = 0.55 // radians of horizontal sweep
    for (let r = 0; r <= rows; r++) {
      const fy = r / rows
      for (let cI = 0; cI <= cols; cI++) {
        const fx = cI / cols
        const i = r * (cols + 1) + cI
        const ang = (fx - 0.5) * arc
        // gently bow the ribbon away from the viewer along Z for depth
        const bow = Math.cos(ang) * width * 0.12
        pos[i * 3] = Math.sin(ang) * (width * 0.5)
        pos[i * 3 + 1] = fy * height
        pos[i * 3 + 2] = -bow
        // vertical fade: bright at the bottom curtain, feathering to the top,
        // and feather the left/right edges too so curtains have soft ends.
        const edge = Math.sin(fx * Math.PI) // 0 at ends, 1 mid
        const vfade = (1 - fy) * 0.7 + 0.3 // base brightness top→bottom
        const k = edge * vfade
        const cTmp = botColor.clone().lerp(topColor, fy)
        colA[i * 3] = cTmp.r * k
        colA[i * 3 + 1] = cTmp.g * k
        colA[i * 3 + 2] = cTmp.b * k
      }
    }
    const idx: number[] = []
    for (let r = 0; r < rows; r++) {
      for (let cI = 0; cI < cols; cI++) {
        const a = r * (cols + 1) + cI
        const b = a + 1
        const d = a + (cols + 1)
        const e = d + 1
        idx.push(a, d, b, b, d, e)
      }
    }
    const geo = track(new THREE.BufferGeometry())
    const attr = new THREE.BufferAttribute(pos, 3)
    attr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', attr)
    geo.setAttribute('color', new THREE.BufferAttribute(colA, 3))
    geo.setIndex(idx)
    const mat = trackM(
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      })
    )
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = -7
    const base = new Float32Array(pos.length)
    base.set(pos)
    return {
      mesh,
      base,
      attr,
      cols,
      rows,
      width,
      height,
      waveAmp: width * (0.05 + rand() * 0.04),
      waveFreq: 1.4 + rand() * 1.0,
      waveSpeed: 0.5 + rand() * 0.5,
      phase: rand() * Math.PI * 2,
      driftSpeed: (rand() < 0.5 ? -1 : 1) * (0.008 + rand() * 0.01),
      yaw0: rand() * Math.PI * 2,
    }
  }

  // a uniform random unit direction biased toward the upper hemisphere
  function randDirUpper(rand: () => number, minY: number, out: THREE.Vector3): THREE.Vector3 {
    const y = minY + rand() * (1 - minY)
    const r2 = Math.sqrt(Math.max(0, 1 - y * y))
    const a = rand() * Math.PI * 2
    out.set(Math.cos(a) * r2, y, Math.sin(a) * r2)
    return out
  }

  // build a thin tapered tail mesh (a flat ribbon along local -X, head at origin)
  // with a head→tail alpha fade baked into vertex colours. Returns geom pieces.
  function buildTail(len: number, halfW: number, color: THREE.Color, hdrHead: number) {
    const seg = 14
    const nV = (seg + 1) * 2
    const pos = new Float32Array(nV * 3)
    const colA = new Float32Array(nV * 3)
    for (let i = 0; i <= seg; i++) {
      const f = i / seg // 0 = head, 1 = tail end
      const x = -f * len
      const w = halfW * (1 - f) // taper to a point
      const fade = (1 - f) * (1 - f) // quadratic fade head→tail
      const cR = color.r * hdrHead * fade
      const cG = color.g * hdrHead * fade
      const cB = color.b * hdrHead * fade
      const top = i * 2
      const bot = i * 2 + 1
      pos[top * 3] = x
      pos[top * 3 + 1] = w
      pos[top * 3 + 2] = 0
      pos[bot * 3] = x
      pos[bot * 3 + 1] = -w
      pos[bot * 3 + 2] = 0
      colA[top * 3] = cR
      colA[top * 3 + 1] = cG
      colA[top * 3 + 2] = cB
      colA[bot * 3] = cR
      colA[bot * 3 + 1] = cG
      colA[bot * 3 + 2] = cB
    }
    const idx: number[] = []
    for (let i = 0; i < seg; i++) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    const geo = track(new THREE.BufferGeometry())
    const attr = new THREE.BufferAttribute(pos, 3)
    attr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', attr)
    geo.setAttribute('color', new THREE.BufferAttribute(colA, 3))
    geo.setIndex(idx)
    const mat = trackM(
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      })
    )
    const base = new Float32Array(pos.length)
    base.set(pos)
    return { mesh: new THREE.Mesh(geo, mat), base, attr }
  }

  return {
    name: 'celestialFX',

    init(ctx: GameContext) {
      const rand = ctx.rand
      glowTex = trackT(makeGlowTexture())

      // ── 1) AURORA — three large curtains high in the sky ──────────────────────
      const curtainSpecs: Array<{ top: THREE.Color; bot: THREE.Color; w: number; h: number; y: number; yaw: number }> = [
        { top: hdr(0.08, 0.85, 0.45), bot: hdr(0.05, 0.45, 0.3), w: FX_R * 0.7, h: FX_R * 0.28, y: FX_R * 0.52, yaw: 0.0 },
        { top: hdr(0.1, 0.65, 0.8), bot: hdr(0.06, 0.35, 0.48), w: FX_R * 0.62, h: FX_R * 0.24, y: FX_R * 0.58, yaw: 2.1 },
        { top: hdr(0.45, 0.2, 0.85), bot: hdr(0.25, 0.12, 0.5), w: FX_R * 0.56, h: FX_R * 0.2, y: FX_R * 0.64, yaw: 4.3 },
      ]
      for (const s of curtainSpecs) {
        const cur = buildCurtain(rand, s.w, s.h, s.top, s.bot)
        cur.yaw0 = s.yaw + rand() * 0.4
        // hang the curtain high: orient it as a vertical sheet on the sky shell.
        // Position its base out on the shell in the curtain's yaw direction, lifted.
        cur.mesh.position.set(0, s.y, -FX_R * 0.95)
        cur.mesh.rotation.y = cur.yaw0
        // a parent pivot lets us yaw-drift the whole curtain around world up.
        const pivot = new THREE.Group()
        pivot.rotation.y = cur.yaw0
        pivot.add(cur.mesh)
        cur.mesh.rotation.y = 0
        ;(cur as { pivot?: THREE.Group }).pivot = pivot
        root.add(pivot)
        curtains.push(cur)
      }

      // ── 2) METEORS — a pool of ~10 shooting-star streaks ──────────────────────
      const METEOR_N = 10
      for (let i = 0; i < METEOR_N; i++) {
        // warm-white with a faint cool/violet variety
        const pick = rand()
        const color =
          pick < 0.7 ? hdr(1.0, 0.95, 0.85) : pick < 0.88 ? hdr(0.7, 0.85, 1.0) : hdr(1.0, 0.7, 0.9)
        const len = FX_R * (0.12 + rand() * 0.08)
        const headSize = FX_R * (0.02 + rand() * 0.012)

        const group = new THREE.Group()
        group.frustumCulled = false

        // head sprite (bright HDR additive)
        const headMat = trackM(
          new THREE.SpriteMaterial({
            map: glowTex!,
            color: color.clone().multiplyScalar(3.2),
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: true,
            toneMapped: false,
            fog: false,
          })
        )
        const head = new THREE.Sprite(headMat)
        head.scale.setScalar(headSize)
        group.add(head)

        // tail ribbon (head→tail fade)
        const tail = buildTail(len, headSize * 0.34, color, 2.6)
        tail.mesh.frustumCulled = false
        group.add(tail.mesh)

        // pre-seed a table of candidate streak directions + timing so update()
        // never calls rand(). Re-use them in a cycling order on recycle.
        const seedN = 6
        const seedFrom: THREE.Vector3[] = []
        const seedTo: THREE.Vector3[] = []
        for (let k = 0; k < seedN; k++) {
          const f = randDirUpper(rand, 0.25, new THREE.Vector3()).clone()
          // a "to" direction: rotate f by a smallish angle to make a chord
          const t = f.clone()
          // tangent perturbation: build an arbitrary tangent and step along it
          _a.set(0, 1, 0)
          if (Math.abs(f.y) > 0.9) _a.set(1, 0, 0)
          _b.crossVectors(f, _a).normalize()
          const ang = 0.5 + rand() * 0.7
          const ax = _b
          t.applyAxisAngle(ax, ang).normalize()
          seedFrom.push(f)
          seedTo.push(t)
        }

        const m: Meteor = {
          group,
          head,
          tailMesh: tail.mesh,
          tailBase: tail.base,
          tailAttr: tail.attr,
          from: seedFrom[0].clone(),
          to: seedTo[0].clone(),
          t: 0,
          speed: 0.7 + rand() * 0.7, // crosses in ~1.4..0.8 s
          active: false,
          delay: rand() * 6, // staggered first launch
          delayBase: 3 + rand() * 6,
          len,
          color,
          seedFrom,
          seedTo,
          seedIdx: 0,
        }
        group.visible = false
        root.add(group)
        meteors.push(m)
      }

      // ── 3) COMET — one slow comet with a long additive tail ───────────────────
      {
        const color = hdr(0.7, 0.95, 1.0)
        const len = FX_R * 0.12
        const group = new THREE.Group()
        group.frustumCulled = false

        // bright bluish-white head
        const headMat = trackM(
          new THREE.SpriteMaterial({
            map: glowTex!,
            color: color.clone().multiplyScalar(1.5),
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            toneMapped: false,
            fog: false,
          })
        )
        const head = new THREE.Sprite(headMat)
        head.scale.setScalar(FX_R * 0.016)
        group.add(head)
        // a soft coma halo behind the head
        const halo = new THREE.Sprite(
          trackM(
            new THREE.SpriteMaterial({
              map: glowTex!,
              color: color.clone().multiplyScalar(1.2),
              transparent: true,
              opacity: 0.6,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
              toneMapped: false,
              fog: false,
            })
          )
        )
        halo.scale.setScalar(FX_R * 0.03)
        group.add(halo)

        const tail = buildTail(len, FX_R * 0.008, color, 1.4)
        tail.mesh.frustumCulled = false
        group.add(tail.mesh)

        const from = randDirUpper(rand, 0.15, new THREE.Vector3()).clone()
        const to = randDirUpper(rand, 0.15, new THREE.Vector3()).clone()
        // make sure to differs enough from from
        if (to.distanceTo(from) < 0.5) to.set(-from.x, from.y, -from.z).normalize()

        root.add(group)
        comet = {
          group,
          from,
          to,
          t: rand(), // start mid-arc
          speed: 0.018 + rand() * 0.01, // very slow drift
          tailMesh: tail.mesh,
          tailBase: tail.base,
          tailAttr: tail.attr,
          len,
        }
      }

      // ── 4) NEBULA — a couple of faint additive glow patches ───────────────────
      const nebSpecs: Array<{ color: THREE.Color; scale: number; minY: number }> = [
        { color: hdr(0.9, 0.35, 0.8), scale: FX_R * 0.7, minY: 0.05 },
        { color: hdr(0.3, 0.55, 1.0), scale: FX_R * 0.55, minY: 0.1 },
        { color: hdr(0.4, 0.9, 0.7), scale: FX_R * 0.45, minY: 0.0 },
      ]
      for (const s of nebSpecs) {
        const mat = trackM(
          new THREE.SpriteMaterial({
            map: glowTex!,
            color: s.color,
            transparent: true,
            opacity: 0.16,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: true,
            toneMapped: false,
            fog: false,
          })
        )
        const spr = new THREE.Sprite(mat)
        spr.scale.setScalar(s.scale)
        const dir = randDirUpper(rand, s.minY, new THREE.Vector3())
        spr.position.copy(dir).multiplyScalar(FX_R * 0.92)
        spr.frustumCulled = false
        spr.renderOrder = -7
        root.add(spr)
        nebulae.push(spr)
      }

      ctx.scene.add(root)
    },

    update(dt: number, ctx: GameContext) {
      acc += dt

      // recenter the whole FX layer on the camera so it reads as infinitely far.
      ctx.camera.getWorldPosition(_cam)
      root.position.copy(_cam)

      // ── AURORA: undulate vertices + slow yaw drift + gentle brightness pulse ──
      for (let ci = 0; ci < curtains.length; ci++) {
        const cur = curtains[ci]
        const base = cur.base
        const arr = cur.attr.array as Float32Array
        const t = acc * cur.waveSpeed + cur.phase
        const n = base.length
        for (let i = 0; i < n; i += 3) {
          const bx = base[i]
          const by = base[i + 1]
          const bz = base[i + 2]
          // horizontal travelling wave whose amplitude grows with height (curtain
          // sways more at the top), plus a secondary ripple for a living shimmer.
          const hf = by / cur.height // 0 bottom → 1 top
          const w =
            Math.sin(bx * cur.waveFreq * 0.0016 + t) * cur.waveAmp * (0.3 + hf) +
            Math.sin(bx * cur.waveFreq * 0.004 - t * 1.7) * cur.waveAmp * 0.35 * hf
          arr[i] = bx
          arr[i + 1] = by
          arr[i + 2] = bz + w
        }
        cur.attr.needsUpdate = true
        const pivot = (cur as { pivot?: THREE.Group }).pivot
        if (pivot) pivot.rotation.y = cur.yaw0 + acc * cur.driftSpeed
        const mat = cur.mesh.material as THREE.MeshBasicMaterial
        mat.opacity = 0.34 + 0.12 * Math.sin(acc * 0.5 + cur.phase)
      }

      // ── METEORS: advance active streaks; recycle finished/idle ones ──────────-
      for (let mi = 0; mi < meteors.length; mi++) {
        const m = meteors[mi]
        if (!m.active) {
          m.delay -= dt
          if (m.delay <= 0) {
            // launch: pick next seeded direction pair (cycling — no rand here)
            m.seedIdx = (m.seedIdx + 1) % m.seedFrom.length
            m.from.copy(m.seedFrom[m.seedIdx])
            m.to.copy(m.seedTo[m.seedIdx])
            m.t = 0
            m.active = true
            m.group.visible = true
          }
          continue
        }
        m.t += dt * m.speed
        if (m.t >= 1) {
          m.active = false
          m.group.visible = false
          m.delay = m.delayBase
          continue
        }
        // head position: slerp-ish lerp of the two unit dirs, projected to shell.
        _v.copy(m.from).lerp(m.to, m.t).normalize()
        m.head.position.copy(_v).multiplyScalar(FX_R)
        // orient the tail to point back along the streak's travel direction.
        // travel dir on the shell:
        _a.copy(m.to).sub(m.from).normalize()
        // tail mesh local -X must align with -travel (tail trails behind head).
        // Build a quaternion that rotates +X(local tail forward) onto -travel.
        _b.set(1, 0, 0)
        m.tailMesh.position.copy(_v).multiplyScalar(FX_R)
        m.tailMesh.quaternion.setFromUnitVectors(_b, _a)
        // fade head + tail in/out: brightest mid-streak, fade at both ends.
        const env = Math.sin(Math.min(1, m.t) * Math.PI)
        const hMat = m.head.material as THREE.SpriteMaterial
        hMat.opacity = env
        const tMat = m.tailMesh.material as THREE.MeshBasicMaterial
        tMat.opacity = 0.9 * env
      }

      // ── COMET: slow great-circle drift; recycle by ping-ponging the arc ───────
      if (comet) {
        comet.t += dt * comet.speed
        if (comet.t >= 1) {
          comet.t = 0
          // swap endpoints so it sweeps back the other way (no rand in update)
          const tmp = comet.from
          comet.from = comet.to
          comet.to = tmp
        }
        _v.copy(comet.from).lerp(comet.to, comet.t).normalize()
        comet.group.position.copy(_v).multiplyScalar(FX_R)
        // point the tail back along -travel
        _a.copy(comet.to).sub(comet.from).normalize()
        _b.set(1, 0, 0)
        comet.tailMesh.quaternion.setFromUnitVectors(_b, _a)
        // also orient the whole group's tail by keeping head/halo as sprites
        // (sprites face the camera automatically; only the tail mesh needs aiming)
      }

      // ── NEBULA: a slow, faint breathing so deep-sky colour gently shimmers ────
      for (let ni = 0; ni < nebulae.length; ni++) {
        const spr = nebulae[ni]
        const mat = spr.material as THREE.SpriteMaterial
        mat.opacity = 0.12 + 0.05 * Math.sin(acc * 0.18 + ni * 1.7)
      }
    },

    dispose() {
      root.parent?.remove(root)
      for (const g of geos) g.dispose()
      for (const m of mats) m.dispose()
      for (const t of texs) t.dispose()
      geos.length = 0
      mats.length = 0
      texs.length = 0
      curtains.length = 0
      meteors.length = 0
      nebulae.length = 0
      comet = null
      glowTex = null
    },
  }
}
