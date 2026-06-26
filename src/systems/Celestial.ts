import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'

/**
 * Celestial — the sky spectacle layer. Everything here is cheap, instanced/pooled,
 * fog:false, and tied to a day/night phase derived from elapsed().
 *
 *   - Aurora ribbons: curved gradient shader meshes that flow & shimmer (all motion
 *     lives in the shader — zero CPU cost). Two-axis travelling ripple + colour
 *     breathing + soft "curtain" streaks read as a living veil.
 *   - Meteor showers: a pooled set of streaks with bright heads + fading tails that
 *     cross the sky in varied bursts (rare singles + dense showers, more at night).
 *   - Floating lanterns: instanced warm-emissive paper lanterns that rise from the
 *     surface with believable buoyant wobble, brighten as they lift, then fade &
 *     respawn. Twin additive glow shell sells the warm bloom.
 *   - Fireflies: additive Points clusters that only appear at dusk/night near the
 *     ground; each fly bobs on its own tiny orbit, clusters breathe out of phase.
 *   - God rays: a soft additive sprite + halo near the sun, brightest in daylight
 *     and when the camera looks toward it.
 *
 * All visuals fade with the day/night cycle: aurora/fireflies/lanterns peak at
 * night, god rays peak in daylight, meteors favour the dark. Nothing allocates
 * per-frame in update().
 */

const PLANET_RADIUS = 100

// ---- Day/night cycle -------------------------------------------------------
// One full day every DAY_LENGTH seconds. phase in [0,1): 0=dawn .25=noon .5=dusk
// .75=midnight. nightAmount is a smooth 0..1 (0 = bright day, 1 = deep night).
const DAY_LENGTH = 120
const TWO_PI = Math.PI * 2

// ---- Pools / counts (mobile budget) ----------------------------------------
const AURORA_RIBBONS = 3
const AURORA_SEGMENTS = 48 // along-curve resolution
const AURORA_WIDTH_SEGS = 2 // a touch more height resolution for the curtain fade
const LANTERN_COUNT = 18
const FIREFLY_CLUSTERS = 4
const FIREFLIES_PER_CLUSTER = 24
const METEOR_COUNT = 16 // pooled streaks; a "shower" lights several at once
const METEOR_TRAIL_PTS = 9 // points along a trail → smoother taper

// ---- Published atmosphere contract (read from Sky) -------------------------
// Sky publishes the live blended day/night state each frame at (ctx as any).sky.
// We READ it to sync the spectacle to the REAL cycle. Fields we use:
//   phaseT01 : 0..1 progress through the whole 195s cycle
//   isNight  : true during the Night segment
//   isDusk   : true during the Evening / dusk segments
// When absent (Sky not yet up on a frame), we fall back to elapsed()-based logic.
interface PublishedSky {
  phaseT01?: number
  isNight?: boolean
  isDusk?: boolean
}

// Reusable 0..1 "atmosphere weights" — filled each frame, never re-allocated.
// day      : 1 = bright daylight, 0 = none
// night    : 1 - day
// deepNight: punchy core-of-night weight (aurora / firefly peak)
// dusk     : magic-hour weight (fireflies first wink on)
// synced   : true when the values came from the REAL published cycle
const _atmo = { day: 1, night: 0, deepNight: 0, dusk: 0, synced: false }

// ---- Module-scoped temps — zero per-frame allocation -----------------------
const _v0 = new THREE.Vector3()
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _scale = new THREE.Vector3()
const _col = new THREE.Color()

// smooth 0..1 ramp
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

// Deterministic per-index pseudo-random in [0,1) so layout is stable & seed-free
// at construction time (we still mix ctx.rand() in init for global variety).
const hash01 = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

interface Meteor {
  active: boolean
  // great-circle-ish straight streak across the sky shell
  origin: THREE.Vector3
  vel: THREE.Vector3
  life: number
  maxLife: number
  len: number // trail length (px) — varies per streak
  bright: number // 0..1 head brightness, used to tint the colour buffer
}

interface FireflyCluster {
  base: THREE.Vector3 // unit surface dir
  points: THREE.Points
  home: Float32Array // resting position per fly (x,y,z)
  jit: Float32Array // per-fly orbit params (ax, ay, az speed/scale packed)
  phase: number
}

export function createCelestialSystem(): GameSystem {
  // Owned objects (assigned in init).
  let group: THREE.Group
  let auroraMat: THREE.ShaderMaterial
  let auroraMeshes: THREE.Mesh[] = []
  let lanterns: THREE.InstancedMesh
  let lanternGlow: THREE.InstancedMesh
  let lanternRise: Float32Array // current risen height per lantern
  let lanternSpeed: Float32Array
  let lanternDir: THREE.Vector3[] // unit surface dir per lantern
  let lanternSpin: Float32Array
  let lanternWobPhase: Float32Array // per-lantern sway phase offset
  let lanternHue: Float32Array // 0..1 warm-tint variation per lantern
  let meteorLines: THREE.LineSegments
  let meteorPositions: Float32Array
  let meteorColors: Float32Array
  let meteors: Meteor[] = []
  let showerTimer = 0
  let showerActive = 0 // remaining streaks to spawn in current shower burst
  let showerSpawnGap = 0
  let fireflies: FireflyCluster[] = []
  let godray: THREE.Sprite
  let godrayMat: THREE.SpriteMaterial
  let sunHalo: THREE.Sprite
  let sunHaloMat: THREE.SpriteMaterial
  const sunDir = new THREE.Vector3(0.3, 0.7, 0.4).normalize()

  // reusable warm meteor colours (head → tail) so we don't alloc per spawn
  const meteorHead = PAL.sun.clone().lerp(PAL.gem, 0.12)
  const meteorTail = PAL.gem.clone().lerp(PAL.skyTop, 0.35)

  // ---- builders ------------------------------------------------------------

  function buildAurora(ctx: GameContext): void {
    // A ribbon is a thin curved strip following a high-altitude latitude band.
    // The shader does ALL the motion (no per-frame CPU). Two travelling ripples on
    // different axes give a flowing veil; colours breathe between green & cyan,
    // kept pastel for cohesion.
    const colA = PAL.gem.clone()
    const colB = PAL.tree.clone().lerp(PAL.gem, 0.45)
    const colTop = PAL.skyTop.clone().lerp(PAL.gem, 0.6)
    const colPink = PAL.planeWing.clone().lerp(PAL.gem, 0.65) // faint warm crown hint

    auroraMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uColA: { value: colA },
        uColB: { value: colB },
        uColTop: { value: colTop },
        uColPink: { value: colPink },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          vUv = uv;
          vec3 p = position;
          // two travelling ripples on different wavelengths/speeds → flowing veil
          float w = sin(uv.x * 18.0 + uTime * 1.30) * 0.45
                  + sin(uv.x * 7.0  - uTime * 0.80) * 0.40
                  + sin(uv.x * 31.0 + uTime * 2.10) * 0.15;
          // taller bottom of the curtain sways more than the wispy top
          float sway = mix(1.6, 0.35, uv.y);
          vWave = w;
          // displace outward along normal so the veil undulates
          p += normal * w * sway;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIntensity;
        uniform vec3 uColA;
        uniform vec3 uColB;
        uniform vec3 uColTop;
        uniform vec3 uColPink;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          float v = vUv.y;
          // base curtain colour drifts green↔cyan along the ribbon + slow breathe
          float breathe = 0.5 + 0.5 * sin(uTime * 0.35 + vUv.x * 2.0);
          vec3 col = mix(uColA, uColB, smoothstep(0.0, 0.6, vUv.x));
          col = mix(col, uColTop, v * v);
          // a whisper of warm pink in the high crown for that real-aurora flush
          col = mix(col, uColPink, v * v * v * 0.5 * breathe);
          // soft vertical falloff (curtain bottom solid, top wispy)
          float curtain = (1.0 - v) * (0.55 + 0.45 * (vWave * 0.5 + 0.5));
          // ragged, drifting vertical streaks (the classic curtain "rays")
          float ray = 0.55 + 0.45 * sin(vUv.x * 60.0 + uTime * 0.9 + vWave * 3.0);
          float ray2 = 0.7 + 0.3 * sin(vUv.x * 23.0 - uTime * 0.5);
          float a = curtain * ray * ray2 * uIntensity;
          gl_FragColor = vec4(col, a);
        }
      `,
    })

    const shellR = PLANET_RADIUS + 95
    for (let r = 0; r < AURORA_RIBBONS; r++) {
      const geo = new THREE.PlaneGeometry(1, 1, AURORA_SEGMENTS, AURORA_WIDTH_SEGS)
      // Re-wrap the flat plane onto a curved band high over one hemisphere.
      const pos = geo.attributes.position as THREE.BufferAttribute
      const nrm = geo.attributes.normal as THREE.BufferAttribute
      // each ribbon gets its own latitude band & longitude sweep
      const lat = 0.45 + (hash01(r * 3.1 + 1) - 0.5) * 0.5 // band center (radians from equator)
      const lonSpan = 2.2 + hash01(r * 1.7) * 1.4 // how far around it sweeps
      const lonStart = ctx.rand() * TWO_PI
      const height = 22 + hash01(r * 5.5) * 16
      for (let i = 0; i < pos.count; i++) {
        const u = pos.getX(i) + 0.5 // 0..1 along ribbon
        const vUp = pos.getY(i) + 0.5 // 0..1 across height
        const lon = lonStart + u * lonSpan
        const wob = Math.sin(u * 6.0 + r) * 0.12
        const theta = lat + wob // polar-ish offset
        // place on a sphere band, push outward, add vertical height
        _dir
          .set(
            Math.cos(theta) * Math.cos(lon),
            Math.sin(theta),
            Math.cos(theta) * Math.sin(lon)
          )
          .normalize()
        const rad = shellR + vUp * height
        _v0.copy(_dir).multiplyScalar(rad)
        pos.setXYZ(i, _v0.x, _v0.y, _v0.z)
        // outward normal for the shader displacement
        nrm.setXYZ(i, _dir.x, _dir.y, _dir.z)
      }
      pos.needsUpdate = true
      nrm.needsUpdate = true
      geo.computeBoundingSphere()
      const mesh = new THREE.Mesh(geo, auroraMat)
      mesh.frustumCulled = false
      mesh.renderOrder = 2
      group.add(mesh)
      auroraMeshes.push(mesh)
    }
  }

  function buildLanterns(ctx: GameContext): void {
    // Low-poly paper lantern: a squashed octahedron body + an additive glow shell.
    const body = new THREE.OctahedronGeometry(1, 0)
    body.scale(1, 1.25, 1)
    const bodyMat = new THREE.MeshBasicMaterial({
      vertexColors: true, // per-instance warm-tint variation
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      fog: false,
      toneMapped: false,
    })
    lanterns = new THREE.InstancedMesh(body, bodyMat, LANTERN_COUNT)
    lanterns.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    lanterns.frustumCulled = false
    lanterns.renderOrder = 1
    group.add(lanterns)

    const glowGeo = new THREE.SphereGeometry(1, 8, 6)
    const glowMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    })
    lanternGlow = new THREE.InstancedMesh(glowGeo, glowMat, LANTERN_COUNT)
    lanternGlow.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    lanternGlow.frustumCulled = false
    lanternGlow.renderOrder = 1
    group.add(lanternGlow)

    lanternRise = new Float32Array(LANTERN_COUNT)
    lanternSpeed = new Float32Array(LANTERN_COUNT)
    lanternSpin = new Float32Array(LANTERN_COUNT)
    lanternWobPhase = new Float32Array(LANTERN_COUNT)
    lanternHue = new Float32Array(LANTERN_COUNT)
    lanternDir = []

    // warm tint endpoints for per-lantern variety (amber → coral-gold)
    const warmA = PAL.planeWing.clone().lerp(PAL.sun, 0.4) // golden amber
    const warmB = PAL.planeWing.clone().lerp(PAL.planeBody, 0.25) // warmer coral-gold
    for (let i = 0; i < LANTERN_COUNT; i++) {
      lanternDir.push(randomUnitDir(ctx))
      lanternRise[i] = ctx.rand() * 70 // staggered start heights
      lanternSpeed[i] = 2.6 + ctx.rand() * 3.2
      lanternSpin[i] = ctx.rand() * TWO_PI
      lanternWobPhase[i] = ctx.rand() * TWO_PI
      const h = ctx.rand()
      lanternHue[i] = h
      // bake a stable base colour per instance (brightness modulated in update)
      _col.copy(warmA).lerp(warmB, h)
      lanterns.setColorAt(i, _col)
      lanternGlow.setColorAt(i, _col)
    }
    if (lanterns.instanceColor) lanterns.instanceColor.needsUpdate = true
    if (lanternGlow.instanceColor) lanternGlow.instanceColor.needsUpdate = true
  }

  function buildFireflies(ctx: GameContext): void {
    const mat = new THREE.PointsMaterial({
      size: 1.7,
      sizeAttenuation: true,
      color: PAL.planeWing.clone().lerp(PAL.sun, 0.5),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    })
    for (let cI = 0; cI < FIREFLY_CLUSTERS; cI++) {
      const base = randomUnitDir(ctx)
      const geo = new THREE.BufferGeometry()
      const arr = new Float32Array(FIREFLIES_PER_CLUSTER * 3)
      const home = new Float32Array(FIREFLIES_PER_CLUSTER * 3)
      const jit = new Float32Array(FIREFLIES_PER_CLUSTER * 4) // sx,sy,sz, speed
      // build a tangent frame at the surface point to scatter flies in a low patch
      const center = ctx.planet.surfacePoint(base, 8)
      makeTangents(base, _v1, _v2)
      for (let i = 0; i < FIREFLIES_PER_CLUSTER; i++) {
        const a = (ctx.rand() - 0.5) * 24
        const b = (ctx.rand() - 0.5) * 24
        const h = ctx.rand() * 7
        _v0.copy(center).addScaledVector(_v1, a).addScaledVector(_v2, b).addScaledVector(base, h)
        arr[i * 3] = _v0.x
        arr[i * 3 + 1] = _v0.y
        arr[i * 3 + 2] = _v0.z
        home[i * 3] = _v0.x
        home[i * 3 + 1] = _v0.y
        home[i * 3 + 2] = _v0.z
        // tiny per-fly drift amplitudes + a personal phase speed
        jit[i * 4] = 0.8 + ctx.rand() * 1.6
        jit[i * 4 + 1] = 0.6 + ctx.rand() * 1.4
        jit[i * 4 + 2] = 0.8 + ctx.rand() * 1.6
        jit[i * 4 + 3] = 0.7 + ctx.rand() * 1.1
      }
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
      ;(geo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage)
      geo.computeBoundingSphere()
      const pts = new THREE.Points(geo, mat.clone())
      pts.frustumCulled = true
      pts.renderOrder = 1
      group.add(pts)
      fireflies.push({ base, points: pts, home, jit, phase: ctx.rand() * TWO_PI })
    }
  }

  function buildMeteors(): void {
    // One LineSegments draw call holds all pooled meteor trails. Each meteor owns
    // a short polyline (METEOR_TRAIL_PTS-1 segments). Inactive meteors collapse to
    // a degenerate point (invisible) — no geometry churn. Per-vertex colour fades
    // a hot head into a cool, transparent tail.
    const segsPerMeteor = METEOR_TRAIL_PTS - 1
    const totalSegs = METEOR_COUNT * segsPerMeteor
    meteorPositions = new Float32Array(totalSegs * 2 * 3)
    meteorColors = new Float32Array(totalSegs * 2 * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(meteorPositions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(meteorColors, 3))
    ;(geo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage)
    ;(geo.attributes.color as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage)
    geo.setDrawRange(0, totalSegs * 2)
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    })
    meteorLines = new THREE.LineSegments(geo, mat)
    meteorLines.frustumCulled = false
    meteorLines.renderOrder = 2
    group.add(meteorLines)

    for (let i = 0; i < METEOR_COUNT; i++) {
      meteors.push({
        active: false,
        origin: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        len: 8,
        bright: 1,
      })
    }
  }

  function buildGodRay(): void {
    // Soft radial sprite that sits at the sun direction; brightest in daylight.
    // A second, larger faint halo gives a believable bloom around the disc.
    const tex = makeRadialTexture()
    godrayMat = new THREE.SpriteMaterial({
      map: tex,
      color: PAL.sun.clone(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    })
    godray = new THREE.Sprite(godrayMat)
    godray.scale.setScalar(220)
    godray.renderOrder = 0
    godray.frustumCulled = false
    group.add(godray)

    sunHaloMat = new THREE.SpriteMaterial({
      map: tex,
      color: PAL.sun.clone().lerp(PAL.planeWing, 0.3),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    })
    sunHalo = new THREE.Sprite(sunHaloMat)
    sunHalo.scale.setScalar(520)
    sunHalo.renderOrder = 0
    sunHalo.frustumCulled = false
    group.add(sunHalo)
  }

  // ---- helpers -------------------------------------------------------------

  // Fill `_atmo` from the REAL published cycle when available, else from our own
  // elapsed()-based fallback. Zero allocation: writes into the shared _atmo object.
  function computeAtmo(t: number, ctx: GameContext): void {
    const sky = (ctx as any).sky as PublishedSky | undefined
    if (sky && typeof sky.phaseT01 === 'number') {
      // --- SYNCED to the real day/night cycle ---------------------------------
      // Reconstruct a smooth sun-elevation from the published phase so transitions
      // (Day→Evening→Night→Day) cross-fade the spectacle just like the sky/lights.
      // Cycle layout (fraction of 195s): Day .00-.308, Night .615-.923, with the
      // evening/dawn ramps between. Peak daylight ~.15, deep midnight ~.77.
      const p = ((sky.phaseT01 % 1) + 1) % 1
      // cosine bump that peaks at p≈.15 (noon) and troughs at p≈.77 (midnight)
      const sunElev = Math.cos((p - 0.15) * TWO_PI)
      let day = smoothstep(-0.2, 0.35, sunElev)
      let night = 1 - day
      // Trust the published booleans to FORCE the right regime at the segment
      // boundaries (so stars/aurora are fully on the instant it's "night").
      if (sky.isNight === true) {
        night = Math.max(night, 0.85)
        day = 1 - night
      }
      const duskFlag = sky.isDusk === true
      // dusk weight: high through the evening band, also rising into early night
      const dusk = duskFlag ? Math.max(0.7, smoothstep(0.05, 0.5, night)) : smoothstep(0.05, 0.45, night)
      const deepNight = smoothstep(0.1, 0.7, night)
      _atmo.day = day
      _atmo.night = night
      _atmo.deepNight = deepNight
      _atmo.dusk = dusk
      _atmo.synced = true
      return
    }
    // --- FALLBACK: original elapsed()-based day/night ------------------------
    const phase = (t / DAY_LENGTH) % 1
    const sunElev = Math.cos((phase - 0.25) * TWO_PI) // peaks at phase .25
    const day = smoothstep(-0.15, 0.25, sunElev)
    const night = 1 - day
    _atmo.day = day
    _atmo.night = night
    _atmo.deepNight = smoothstep(0.1, 0.7, night)
    _atmo.dusk = smoothstep(0.05, 0.45, night)
    _atmo.synced = false
  }

  function randomUnitDir(ctx: GameContext): THREE.Vector3 {
    // uniform-ish on sphere
    const z = ctx.rand() * 2 - 1
    const a = ctx.rand() * TWO_PI
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    return new THREE.Vector3(Math.cos(a) * r, z, Math.sin(a) * r).normalize()
  }

  // build two unit tangents perpendicular to `n` (into out1,out2)
  function makeTangents(n: THREE.Vector3, out1: THREE.Vector3, out2: THREE.Vector3): void {
    const ref = Math.abs(n.y) < 0.99 ? _up : _v3.set(1, 0, 0)
    out1.crossVectors(ref, n).normalize()
    out2.crossVectors(n, out1).normalize()
  }

  function makeRadialTexture(): THREE.CanvasTexture {
    const size = 128
    const cnv = document.createElement('canvas')
    cnv.width = cnv.height = size
    const g = cnv.getContext('2d')!
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grd.addColorStop(0, 'rgba(255,255,255,0.95)')
    grd.addColorStop(0.2, 'rgba(255,255,255,0.45)')
    grd.addColorStop(0.55, 'rgba(255,255,255,0.12)')
    grd.addColorStop(1, 'rgba(255,255,255,0.0)')
    g.fillStyle = grd
    g.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(cnv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return tex
  }

  function makeStarTexture(): THREE.CanvasTexture {
    // tiny soft dot for fireflies/points
    return makeRadialTexture()
  }

  // ---- meteor pool ---------------------------------------------------------

  function spawnMeteor(ctx: GameContext): void {
    let m: Meteor | undefined
    for (let i = 0; i < meteors.length; i++) {
      if (!meteors[i].active) {
        m = meteors[i]
        break
      }
    }
    if (!m) return
    // Start high on the sky shell, travel along a tangent across the dome.
    const shell = PLANET_RADIUS + 110 + ctx.rand() * 40
    const dir = randomUnitDir(ctx)
    m.origin.copy(dir).multiplyScalar(shell)
    makeTangents(dir, _v1, _v2)
    const ang = ctx.rand() * TWO_PI
    const speed = 150 + ctx.rand() * 160 // varied — some lazy, some blazing
    m.vel
      .copy(_v1)
      .multiplyScalar(Math.cos(ang))
      .addScaledVector(_v2, Math.sin(ang))
      .normalize()
      .multiplyScalar(speed)
    // slight inward dip so they arc toward the horizon
    m.vel.addScaledVector(dir, -20)
    m.maxLife = 1.0 + ctx.rand() * 1.1
    m.life = m.maxLife
    // faster streaks get longer trails; slow ones are short & gentle
    m.len = 6 + ctx.rand() * 10 + (speed - 150) * 0.04
    m.bright = 0.7 + ctx.rand() * 0.3
    m.active = true
  }

  function updateMeteors(dt: number, ctx: GameContext, visible: number): void {
    // shower scheduling: rare bursts that spawn a clutch of streaks
    showerTimer -= dt
    if (showerActive > 0) {
      showerSpawnGap -= dt
      if (showerSpawnGap <= 0) {
        spawnMeteor(ctx)
        showerActive--
        showerSpawnGap = 0.1 + ctx.rand() * 0.28
      }
    } else if (showerTimer <= 0) {
      // schedule next event; more frequent at night
      showerTimer = 12 + ctx.rand() * 20 - visible * 7
      // mix of lonely singles and dense showers for variety
      if (ctx.rand() < 0.35) {
        showerActive = 1 + Math.floor(ctx.rand() * 2) // quiet single/double
      } else {
        showerActive = 5 + Math.floor(ctx.rand() * 8) // proper shower (5..12)
      }
      showerSpawnGap = 0
    }

    const segsPerMeteor = METEOR_TRAIL_PTS - 1
    const floatsPerMeteor = segsPerMeteor * 2 * 3
    let anyActive = false
    for (let i = 0; i < meteors.length; i++) {
      const m = meteors[i]
      const off = i * floatsPerMeteor
      if (!m.active) {
        // collapse to degenerate (invisible) line
        collapseMeteor(off)
        continue
      }
      anyActive = true
      m.life -= dt
      if (m.life <= 0) {
        m.active = false
        collapseMeteor(off)
        continue
      }
      // advance head
      m.origin.addScaledVector(m.vel, dt)
      // direction the trail extends (behind the head)
      _v0.copy(m.vel).normalize()
      // life-based fade: streak brightens on entry, fades as it dies
      const lifeT = m.life / m.maxLife // 1 → 0
      const fade = smoothstep(0, 0.25, lifeT) * m.bright * Math.max(0.25, visible)
      // trail grows slightly as the streak ages, then we taper colour per-segment
      const trailLen = m.len * (0.6 + (1 - lifeT) * 0.6)
      for (let s = 0; s < segsPerMeteor; s++) {
        const t0 = s / segsPerMeteor
        const t1 = (s + 1) / segsPerMeteor
        _v1.copy(m.origin).addScaledVector(_v0, -t0 * trailLen)
        _v2.copy(m.origin).addScaledVector(_v0, -t1 * trailLen)
        const b = off + s * 6
        meteorPositions[b] = _v1.x
        meteorPositions[b + 1] = _v1.y
        meteorPositions[b + 2] = _v1.z
        meteorPositions[b + 3] = _v2.x
        meteorPositions[b + 4] = _v2.y
        meteorPositions[b + 5] = _v2.z
        // colour: hot head (warm) → cool transparent tail, scaled by fade
        const c0 = (1 - t0) * (1 - t0) * fade
        const c1 = (1 - t1) * (1 - t1) * fade
        _col.copy(meteorHead).lerp(meteorTail, t0)
        meteorColors[b] = _col.r * c0
        meteorColors[b + 1] = _col.g * c0
        meteorColors[b + 2] = _col.b * c0
        _col.copy(meteorHead).lerp(meteorTail, t1)
        meteorColors[b + 3] = _col.r * c1
        meteorColors[b + 4] = _col.g * c1
        meteorColors[b + 5] = _col.b * c1
      }
    }
    meteorLines.visible = anyActive
    const posAttr = meteorLines.geometry.attributes.position as THREE.BufferAttribute
    const colAttr = meteorLines.geometry.attributes.color as THREE.BufferAttribute
    posAttr.needsUpdate = true
    colAttr.needsUpdate = true
  }

  function collapseMeteor(off: number): void {
    const floats = (METEOR_TRAIL_PTS - 1) * 2 * 3
    for (let k = 0; k < floats; k++) {
      meteorPositions[off + k] = 0
      meteorColors[off + k] = 0
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  return {
    name: 'celestial',

    init(ctx: GameContext): void {
      group = new THREE.Group()
      group.name = 'celestial'
      // sun direction: roughly toward the existing key light feel; high & warm.
      sunDir.set(0.35, 0.78, 0.42).normalize()

      buildAurora(ctx)
      buildLanterns(ctx)
      buildFireflies(ctx)
      buildMeteors()
      buildGodRay()

      // upgrade firefly material with a soft sprite so points read as glow dots
      const fireTex = makeStarTexture()
      for (const fc of fireflies) {
        ;(fc.points.material as THREE.PointsMaterial).map = fireTex
        ;(fc.points.material as THREE.PointsMaterial).needsUpdate = true
      }

      // place god ray far along sun direction (rotates with day/night below)
      godray.position.copy(sunDir).multiplyScalar(PLANET_RADIUS + 400)
      sunHalo.position.copy(godray.position)

      ctx.scene.add(group)

      // prime instance matrices once
      for (let i = 0; i < LANTERN_COUNT; i++) {
        lanterns.setMatrixAt(i, _m.identity())
        lanternGlow.setMatrixAt(i, _m.identity())
      }
      lanterns.instanceMatrix.needsUpdate = true
      lanternGlow.instanceMatrix.needsUpdate = true
    },

    update(dt: number, ctx: GameContext): void {
      const t = ctx.elapsed()
      // Pull day/night weights from the REAL published cycle (Sky) when present,
      // else fall back to our own elapsed()-based phase. Fills shared `_atmo`.
      computeAtmo(t, ctx)
      const day = _atmo.day // 1 = bright day
      const night = _atmo.night
      const deepNight = _atmo.deepNight // aurora / firefly punch near midnight
      const dusk = _atmo.dusk // magic-hour band where fireflies first wink on

      // --- rotate sun & god ray slowly across the sky -----------------------
      // Drive the sun by the published phase when synced so the god ray sits at
      // the REAL sun; otherwise use our own elapsed()-based phase.
      const phase = _atmo.synced
        ? ((((ctx as any).sky as PublishedSky).phaseT01! % 1) + 1) % 1
        : (t / DAY_LENGTH) % 1
      const sunAng = phase * TWO_PI
      sunDir
        .set(
          Math.cos(sunAng) * 0.5,
          Math.sin((phase - 0.25) * TWO_PI), // up at noon
          Math.sin(sunAng) * 0.5
        )
        .normalize()
      godray.position.copy(sunDir).multiplyScalar(PLANET_RADIUS + 400)
      sunHalo.position.copy(godray.position)
      // god ray strongest when sun is up AND we are looking toward it
      ctx.camera.getWorldDirection(_v0)
      const facing = Math.max(0, _v0.dot(_dir.copy(sunDir)))
      const facing2 = facing * facing
      godrayMat.opacity = day * (0.12 + 0.5 * facing2)
      sunHaloMat.opacity = day * (0.05 + 0.22 * facing2)
      // gently pulse scale (shimmer in the rays)
      godray.scale.setScalar(200 + Math.sin(t * 0.6) * 14)
      sunHalo.scale.setScalar(480 + Math.sin(t * 0.4 + 1.5) * 30)

      // --- aurora shimmer ---------------------------------------------------
      auroraMat.uniforms.uTime.value = t
      auroraMat.uniforms.uIntensity.value = 0.04 + deepNight * 0.9

      // --- floating lanterns ------------------------------------------------
      // lanterns visible mostly at dusk→night (cozy)
      const lanternVis = smoothstep(0.05, 0.5, night)
      const lanternMat = lanterns.material as THREE.MeshBasicMaterial
      const glowMat = lanternGlow.material as THREE.MeshBasicMaterial
      lanternMat.opacity = lanternVis
      glowMat.opacity = 0.4 * lanternVis
      lanterns.visible = lanternVis > 0.01
      lanternGlow.visible = lanterns.visible
      if (lanterns.visible) {
        for (let i = 0; i < LANTERN_COUNT; i++) {
          lanternRise[i] += lanternSpeed[i] * dt
          // fade lifecycle baked into rise height; respawn at top
          if (lanternRise[i] > 92) {
            lanternRise[i] = 0
            lanternDir[i].copy(randomUnitDir(ctx))
          }
          const rise = lanternRise[i]
          const dir = lanternDir[i]
          // buoyant wobble: gentle, slowing as it climbs (thinner air feel)
          lanternSpin[i] += dt * (0.7 - rise * 0.003)
          const ph = lanternWobPhase[i]
          const wobX = Math.sin(lanternSpin[i] + ph) * 1.6
          const wobZ = Math.cos(lanternSpin[i] * 0.8 + ph) * 1.3
          // surface point lifted by current rise height
          _v0.copy(ctx.planet.surfacePoint(dir, 4 + rise))
          // sway laterally on the tangent plane
          makeTangents(dir, _v1, _v2)
          _v0.addScaledVector(_v1, wobX).addScaledVector(_v2, wobZ)
          // orient: local +Y along surface normal (dir), with a slight lean
          _q.setFromUnitVectors(_up, dir)
          // breathing scale + a subtle bob makes them feel hand-lit
          const s = 1.4 + Math.sin(lanternSpin[i] * 1.3 + ph) * 0.07
          _scale.set(s, s * 1.05, s)
          _m.compose(_v0, _q, _scale)
          lanterns.setMatrixAt(i, _m)
          // glow shell pulses a touch wider than the body (warm bloom)
          const gs = s * (2.1 + Math.sin(t * 1.6 + ph) * 0.18)
          _scale.set(gs, gs, gs)
          _m.compose(_v0, _q, _scale)
          lanternGlow.setMatrixAt(i, _m)
        }
        lanterns.instanceMatrix.needsUpdate = true
        lanternGlow.instanceMatrix.needsUpdate = true
      }

      // --- fireflies --------------------------------------------------------
      // only at dusk/night, near the ground; each fly bobs on its own orbit
      const fireVis = dusk * (0.4 + 0.6 * deepNight)
      for (let i = 0; i < fireflies.length; i++) {
        const fc = fireflies[i]
        const mat = fc.points.material as THREE.PointsMaterial
        // breathe: each cluster pulses out of phase
        const pulse = 0.5 + 0.5 * Math.sin(t * 1.4 + fc.phase)
        mat.opacity = fireVis * (0.3 + 0.7 * pulse)
        const visible = mat.opacity > 0.02
        fc.points.visible = visible
        if (!visible) continue
        // drift each fly around its home on a tiny lissajous orbit
        const geo = fc.points.geometry
        const attr = geo.attributes.position as THREE.BufferAttribute
        const arr = attr.array as Float32Array
        const home = fc.home
        const jit = fc.jit
        for (let f = 0; f < FIREFLIES_PER_CLUSTER; f++) {
          const o = f * 3
          const j = f * 4
          const sp = jit[j + 3]
          const ph = fc.phase + f * 0.7
          arr[o] = home[o] + Math.sin(t * sp + ph) * jit[j]
          arr[o + 1] = home[o + 1] + Math.sin(t * sp * 1.3 + ph * 1.7) * jit[j + 1]
          arr[o + 2] = home[o + 2] + Math.cos(t * sp * 0.9 + ph) * jit[j + 2]
        }
        attr.needsUpdate = true
      }

      // --- meteors ----------------------------------------------------------
      // showers more likely / visible at night
      updateMeteors(dt, ctx, 0.2 + night * 0.8)
    },

    dispose(): void {
      if (!group) return
      group.traverse((o) => {
        const mesh = o as THREE.Mesh
        const g = (mesh as any).geometry as THREE.BufferGeometry | undefined
        if (g && typeof g.dispose === 'function') g.dispose()
        const mat = (mesh as any).material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((mm) => disposeMat(mm))
        else if (mat) disposeMat(mat)
      })
      group.parent?.remove(group)
      auroraMeshes = []
      meteors = []
      fireflies = []
    },
  }

  function disposeMat(m: THREE.Material): void {
    const anyM = m as any
    if (anyM.map && typeof anyM.map.dispose === 'function') anyM.map.dispose()
    m.dispose()
  }
}
