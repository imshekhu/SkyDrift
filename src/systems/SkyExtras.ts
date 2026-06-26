import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'

/**
 * SkyExtras — two atmosphere accents that live ON the sky shell, behind the
 * world, recentred on the camera every frame so they read as far-off backdrop:
 *
 *   • MOON — a soft low-poly moon disc with a baked crater/limb gradient + an
 *     additive halo. Fades IN only at dusk/night, drifts gently, and is parked
 *     roughly OPPOSITE the sun so the two never share the sky. Its phase/glow
 *     ride the shared (ctx as any).sky.isNight / .isDusk if Sky publishes them,
 *     else a self-derived day/night clock keeps it standalone.
 *
 *   • RAINBOW — a large semicircular ARCH (a half-torus ribbon) with a 7-band
 *     ROYGBIV gradient baked into a 1×N ramp texture, soft + additive, sitting
 *     on the horizon. Shown when (ctx as any).weather.rainbow is true; fades
 *     in/out over ~1.5s and its opacity is also tied to daylight (a rainbow
 *     needs sun, so it dims at night).
 *
 * Both are mobile-cheap (two low-poly meshes + two sprites, one ramp texture,
 * one radial texture) and allocate NOTHING per frame — all maths reuse
 * module-scoped temporaries; only material opacities and a couple of transforms
 * change each tick.
 */

const PLANET_RADIUS = 100

// Where the accents sit: comfortably inside the sky dome (R≈1200) and the camera
// far plane (1400) so they never clip, far enough to read as "at the horizon".
const SKY_SHELL = 1050

// Self-derived day/night clock — matches the documented TinySkies 195s cycle so
// the moon behaves sensibly even before Sky publishes (ctx as any).sky.
const CYCLE_SECONDS = 195
const TWO_PI = Math.PI * 2

// Fade rates (per second) → ~1.5s eases for the rainbow, a touch slower for the
// moon so it ghosts in at dusk.
const RAINBOW_FADE = 1 / 1.5
const MOON_FADE = 1 / 2.0

// ---- module-scoped temporaries (zero per-frame allocation) -----------------
const _camWorld = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _tangent = new THREE.Vector3()
const _sunDir = new THREE.Vector3()
const _moonDir = new THREE.Vector3()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
// frame-rate-independent approach toward 1 over a fade with the given rate.
const approach = (cur: number, target: number, rate: number, dt: number): number => {
  const k = 1 - Math.exp(-rate * dt * 3)
  return cur + (target - cur) * k
}

/** Soft radial glow → CanvasTexture (moon halo + disc shading base). */
function makeRadialTexture(coreAlpha: number): THREE.CanvasTexture {
  const size = 128
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const g = cv.getContext('2d')!
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grd.addColorStop(0.0, `rgba(255,255,255,${coreAlpha})`)
  grd.addColorStop(0.35, `rgba(255,255,255,${coreAlpha * 0.5})`)
  grd.addColorStop(0.7, `rgba(255,255,255,${coreAlpha * 0.14})`)
  grd.addColorStop(1.0, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

/** 1×N ROYGBIV ramp baked once → sampled across the torus tube by uv.x. */
function makeRainbowRamp(): THREE.CanvasTexture {
  const w = 128
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = 1
  const g = cv.getContext('2d')!
  const grd = g.createLinearGradient(0, 0, w, 0)
  // outer rim (red) → inner rim (violet); soft transparent shoulders so the band
  // melts into the sky rather than ending in a hard edge.
  grd.addColorStop(0.0, 'rgba(255,60,52,0.0)')
  grd.addColorStop(0.08, 'rgba(255,60,52,1.0)') // red
  grd.addColorStop(0.22, 'rgba(255,150,40,1.0)') // orange
  grd.addColorStop(0.36, 'rgba(255,228,80,1.0)') // yellow
  grd.addColorStop(0.5, 'rgba(95,220,110,1.0)') // green
  grd.addColorStop(0.64, 'rgba(70,170,255,1.0)') // blue
  grd.addColorStop(0.78, 'rgba(80,90,230,1.0)') // indigo
  grd.addColorStop(0.92, 'rgba(170,80,230,1.0)') // violet
  grd.addColorStop(1.0, 'rgba(170,80,230,0.0)')
  g.fillStyle = grd
  g.fillRect(0, 0, w, 1)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

export function createSkyExtrasSystem(): GameSystem {
  let group: THREE.Group

  // Moon: low-poly disc-ish sphere with a baked gradient, plus an additive halo.
  let moon: THREE.Mesh
  let moonMat: THREE.MeshBasicMaterial
  let moonHalo: THREE.Sprite
  let moonHaloMat: THREE.SpriteMaterial
  let moonTex: THREE.CanvasTexture
  let haloTex: THREE.CanvasTexture
  let moonOpacity = 0

  // Rainbow: a half-torus ribbon with a ROYGBIV ramp.
  let rainbow: THREE.Mesh
  let rainbowMat: THREE.ShaderMaterial
  let rampTex: THREE.CanvasTexture
  let rainbowOpacity = 0

  // ---- moon face texture: a craggy lit disc (no per-frame work) ------------
  function makeMoonTexture(): THREE.CanvasTexture {
    const size = 256
    const cv = document.createElement('canvas')
    cv.width = cv.height = size
    const g = cv.getContext('2d')!
    g.clearRect(0, 0, size, size)
    const cx = size / 2
    const cy = size / 2
    const r = size / 2
    // body: cool pearl, lit from upper-left → terminator shadow lower-right.
    const body = g.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r)
    body.addColorStop(0.0, 'rgba(245,247,255,1.0)')
    body.addColorStop(0.55, 'rgba(206,214,240,1.0)')
    body.addColorStop(0.85, 'rgba(150,162,205,1.0)')
    body.addColorStop(1.0, 'rgba(120,132,180,1.0)')
    g.save()
    g.beginPath()
    g.arc(cx, cy, r - 1, 0, TWO_PI)
    g.closePath()
    g.clip()
    g.fillStyle = body
    g.fillRect(0, 0, size, size)
    // subtle craters — a handful of soft darker discs (baked, deterministic).
    const craters: [number, number, number][] = [
      [0.36, 0.34, 0.1],
      [0.62, 0.3, 0.07],
      [0.5, 0.56, 0.13],
      [0.3, 0.62, 0.06],
      [0.7, 0.62, 0.09],
      [0.46, 0.78, 0.05],
    ]
    for (const [u, v, cr] of craters) {
      const ccx = u * size
      const ccy = v * size
      const crr = cr * size
      const cg = g.createRadialGradient(ccx, ccy, 0, ccx, ccy, crr)
      cg.addColorStop(0.0, 'rgba(120,130,170,0.55)')
      cg.addColorStop(0.6, 'rgba(140,150,190,0.28)')
      cg.addColorStop(1.0, 'rgba(150,162,205,0.0)')
      g.fillStyle = cg
      g.beginPath()
      g.arc(ccx, ccy, crr, 0, TWO_PI)
      g.fill()
    }
    g.restore()
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return tex
  }

  function buildMoon(ctx: GameContext): void {
    moonTex = makeMoonTexture()
    // Low-poly sphere (cheap) carrying the baked face; toneMapped:false keeps it
    // pearly under AgX. Always faces the camera enough via its position on the shell.
    const geo = new THREE.SphereGeometry(1, 16, 12)
    moonMat = new THREE.MeshBasicMaterial({
      map: moonTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    })
    moon = new THREE.Mesh(geo, moonMat)
    moon.scale.setScalar(46)
    moon.frustumCulled = false
    moon.renderOrder = -8 // with the stars: behind the world, in front of the dome
    moon.matrixAutoUpdate = false
    group.add(moon)

    haloTex = makeRadialTexture(0.85)
    moonHaloMat = new THREE.SpriteMaterial({
      map: haloTex,
      color: PAL.gem.clone().lerp(PAL.skyTop, 0.25),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    })
    moonHalo = new THREE.Sprite(moonHaloMat)
    moonHalo.scale.setScalar(150)
    moonHalo.frustumCulled = false
    moonHalo.renderOrder = -9 // behind the disc
    moonHalo.matrixAutoUpdate = false
    group.add(moonHalo)
    void ctx
  }

  function buildRainbow(): void {
    rampTex = makeRainbowRamp()
    // Half-torus: an arch sitting on the horizon. The tube is wide; the ramp runs
    // ACROSS the tube (uv.y on a TorusGeometry) so the 7 bands stack across the
    // arc's thickness. The shader fades the two ends so it melts into the sky.
    // arc = PI (a semicircle); the open side points down at the horizon.
    const R = SKY_SHELL * 0.5
    const tube = R * 0.10
    const geo = new THREE.TorusGeometry(R, tube, 8, 96, Math.PI)
    rainbowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      fog: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uRamp: { value: rampTex },
        uOpacity: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform sampler2D uRamp;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          // uv.y runs across the tube → ROYGBIV bands. uv.x runs along the arch.
          vec4 band = texture2D(uRamp, vec2(vUv.y, 0.5));
          // fade the two ends (uv.x near 0 and 1) so the arch dissolves into sky.
          float ends = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x);
          float a = band.a * ends * uOpacity;
          gl_FragColor = vec4(band.rgb, a);
        }
      `,
    })
    rainbow = new THREE.Mesh(geo, rainbowMat)
    rainbow.frustumCulled = false
    rainbow.renderOrder = -7 // in front of dome/stars, behind the world
    rainbow.matrixAutoUpdate = false
    rainbow.visible = false
    group.add(rainbow)
  }

  // ---- shared-state readers (defensive: Sky/Weather may not publish yet) ----

  /** Returns the sun direction + a 0..1 night amount, preferring published sky. */
  function resolveSun(ctx: GameContext, nightOut: { night: number; dusk: number }): void {
    // planet-relative up at the camera (the world is a small globe).
    ctx.camera.getWorldPosition(_camWorld)
    _up.copy(_camWorld).sub(ctx.planet.mesh.position).normalize()
    if (!isFinite(_up.x) || _up.lengthSq() < 1e-6) _up.set(0, 1, 0)
    // a stable tangent in the up-plane (mirrors Sky.ts so sun/moon agree).
    _tangent.set(0, 1, 0)
    if (Math.abs(_up.dot(_tangent)) > 0.92) _tangent.set(1, 0, 0)
    _tangent.crossVectors(_up, _tangent).normalize()

    const sky = (ctx as any).sky as
      | { phaseT01?: number; isNight?: boolean; isDusk?: boolean }
      | undefined

    // sun elevation: prefer the shared phase; else derive from our own clock.
    let elev: number
    let night: number
    let dusk: number
    if (sky && typeof sky.phaseT01 === 'number') {
      // phaseT01 0..1 through the cycle. Map to an elevation arc (noon high).
      const phase = sky.phaseT01
      elev = Math.cos((phase - 0.25) * TWO_PI)
      night = sky.isNight ? 1 : smoothstep(0.2, -0.2, elev)
      dusk = sky.isDusk ? 1 : smoothstep(0.35, 0.0, elev) * (1 - night * 0.5)
    } else {
      const phase = (ctx.elapsed() % CYCLE_SECONDS) / CYCLE_SECONDS
      elev = Math.cos((phase - 0.25) * TWO_PI)
      const day = smoothstep(-0.15, 0.25, elev)
      night = 1 - day
      dusk = smoothstep(0.05, 0.45, night) * (1 - smoothstep(0.6, 0.95, night))
    }
    nightOut.night = night
    nightOut.dusk = dusk

    // sun on the up/tangent arc (same construction Sky.ts uses).
    _sunDir
      .copy(_up)
      .multiplyScalar(elev)
      .addScaledVector(_tangent, Math.sqrt(Math.max(0, 1 - elev * elev)))
      .normalize()
  }

  // reused scratch struct → zero per-frame alloc.
  const _na = { night: 0, dusk: 0 }

  return {
    name: 'skyExtras',

    init(ctx: GameContext): void {
      group = new THREE.Group()
      group.name = 'skyExtras'
      buildMoon(ctx)
      buildRainbow()
      ctx.scene.add(group)
      // prime to a sensible first frame.
      this.update(0, ctx)
    },

    update(dt: number, ctx: GameContext): void {
      resolveSun(ctx, _na)
      const night = _na.night
      const dusk = _na.dusk
      const t = ctx.elapsed()

      // === MOON ============================================================
      // Visible at dusk/night; opposite-ish the sun, drifting gently. The moon
      // sits high and OPPOSITE the sun on the up/tangent plane, with a small
      // wandering offset so it isn't a perfect mirror.
      const moonVis = clamp01(Math.max(night, dusk * 0.85))
      moonOpacity = approach(moonOpacity, moonVis, MOON_FADE, dt)

      const visible = moonOpacity > 0.01
      moon.visible = visible
      moonHalo.visible = visible
      if (visible) {
        // opposite the sun, lifted toward the zenith, with a slow lateral drift.
        const drift = Math.sin(t * 0.03) * 0.18
        _moonDir
          .copy(_sunDir)
          .multiplyScalar(-1)
          .addScaledVector(_up, 0.55) // keep it high in the sky
          .addScaledVector(_tangent, drift)
          .normalize()
        _p.copy(_camWorld).addScaledVector(_moonDir, SKY_SHELL)
        moon.position.copy(_p)
        // gentle bob in apparent size to feel hand-placed, and keep facing camera.
        const s = 46 + Math.sin(t * 0.25) * 1.5
        moon.scale.setScalar(s)
        // orient the baked face toward the camera (billboard-ish for the sphere).
        _q.setFromRotationMatrix(
          _mLookAt(moon.position, _camWorld, _up)
        )
        moon.quaternion.copy(_q)
        moon.updateMatrix()

        const mMat = moonMat
        mMat.opacity = moonOpacity
        moonHalo.position.copy(_p)
        const hg = s * (3.0 + Math.sin(t * 0.5) * 0.12)
        moonHalo.scale.setScalar(hg)
        moonHalo.updateMatrix()
        moonHaloMat.opacity = moonOpacity * 0.5
      }

      // === RAINBOW =========================================================
      // Shown when weather.rainbow is true; fades over ~1.5s; needs daylight, so
      // its opacity also scales with (1 - night) → dims toward dusk, gone at night.
      const weather = (ctx as any).weather as { rainbow?: boolean } | undefined
      const wantRainbow = !!(weather && weather.rainbow)
      const daylight = clamp01(1 - night)
      const targetRainbow = wantRainbow ? daylight : 0
      rainbowOpacity = approach(rainbowOpacity, targetRainbow, RAINBOW_FADE, dt)

      const rVisible = rainbowOpacity > 0.01
      rainbow.visible = rVisible
      if (rVisible) {
        // The arch stands OPPOSITE the sun (a real rainbow is anti-solar) and low
        // on the horizon: centre it just below the horizon ring so only the arc
        // shows. Build an anti-solar direction projected toward the horizon.
        _moonDir.copy(_sunDir).multiplyScalar(-1)
        // flatten toward the horizon plane so the arch sits ON the horizon.
        const upComp = _moonDir.dot(_up)
        _moonDir.addScaledVector(_up, -upComp).normalize()
        // place the arch's centre out on the shell, dropped a touch below horizon.
        _p.copy(_camWorld)
          .addScaledVector(_moonDir, SKY_SHELL * 0.72)
          .addScaledVector(_up, -SKY_SHELL * 0.12)
        rainbow.position.copy(_p)
        // orient: the torus lies in its local XY plane with the open side toward
        // -Y. We want local +Y = world up, and the arch facing the camera (along
        // the anti-solar direction). Build a basis: forward = -antiSolar (toward
        // camera), up = planet up.
        _q.setFromRotationMatrix(
          _mBasis(_moonDir, _up)
        )
        rainbow.quaternion.copy(_q)
        rainbow.updateMatrix()
        rainbowMat.uniforms.uOpacity.value = rainbowOpacity * 0.85
      }
    },

    dispose(): void {
      if (!group) return
      moonMat.dispose()
      moonTex.dispose()
      moonHaloMat.dispose()
      haloTex.dispose()
      rainbowMat.dispose()
      rampTex.dispose()
      group.traverse((o) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
        if (g && typeof g.dispose === 'function') g.dispose()
      })
      group.parent?.remove(group)
    },
  }
}

// ---- tiny matrix helpers (module-scoped, no per-frame allocation) ----------
const _mat = new THREE.Matrix4()
const _eye = new THREE.Vector3()
const _zAxis = new THREE.Vector3()
const _xAxis = new THREE.Vector3()
const _yAxis = new THREE.Vector3()

/** lookAt matrix placing the object at `pos` facing `target` (reused _mat). */
function _mLookAt(pos: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3): THREE.Matrix4 {
  _eye.copy(pos)
  _mat.lookAt(_eye, target, up)
  return _mat
}

/**
 * Basis matrix for the rainbow arch. We want:
 *   local +Y → world `up`        (arch stands upright)
 *   local +Z → `face` (toward camera / anti-solar)
 * so the semicircle (which spans local +X→ -X across its top, opening toward -Y)
 * reads as an arch on the horizon facing the viewer. Reuses _mat.
 */
function _mBasis(face: THREE.Vector3, up: THREE.Vector3): THREE.Matrix4 {
  _zAxis.copy(face).normalize()
  _xAxis.crossVectors(up, _zAxis).normalize()
  _yAxis.crossVectors(_zAxis, _xAxis).normalize()
  _mat.makeBasis(_xAxis, _yAxis, _zAxis)
  return _mat
}
