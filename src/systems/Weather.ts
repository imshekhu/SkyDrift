import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { damp } from '../plane/flight'

/**
 * Weather — faithful TinySkies RAIN as a camera-locked, screen-space overlay.
 *
 * Render strategy (mobile-safe): instead of a second OrthographicCamera pass
 * rendered after the scene (which fights this project's EffectComposer — the
 * composer owns the only render() call, and systems update() BEFORE it), the
 * rain is a small group PARENTED to the camera and pinned just inside the near
 * plane. It therefore travels with the view, always faces it, and the existing
 * composer draws it for free every frame. depthTest:false + a tiny camera-space
 * Z keeps it on top of the world without z-fighting; fog:false keeps it crisp.
 *
 *   (1) STREAKS — ~180 thin tapered quads (the recipe's streak shader), additive,
 *       canted to a slight wind angle (~0.35rad). They fall down screen space and
 *       wrap, so a fixed pool tiles the viewport forever (zero churn). Opacity is
 *       driven by a smoothly-ramped rainIntensity01 (fade in/out over ~2s).
 *   (2) GLASS DROPLETS — an OPTIONAL cheap full-screen lens pass: a single quad
 *       with a procedural raindrops-on-glass shader (no scene sampling, so it
 *       composites without a render-target round-trip — the costly refraction is
 *       faked with additive highlights). Auto-skipped on low-end (DPR<2 or coarse
 *       pointer) to protect the 60fps budget.
 *
 * Scheduling: mostly clear, with rain SPELLS (~20-40s) every ~90-150s. During a
 * spell we nudge the published sky fog ~15% darker, call ctx.audio.play("rain")
 * on a slow cadence (looping-ish — the audio bus has no sustained loop), and on
 * a DAYTIME spell's end we raise weather.rainbow for ~12s so sky-extras can show
 * an arc.
 *
 * Publishes (ctx as any).weather = { raining, rainIntensity01, rainbow }.
 * Reads (ctx as any).sky?.{ isNight, fogColor } when present (optional contract).
 *
 * Budget: zero per-frame allocation (module-scoped temporaries), one Instanced
 * draw for the streaks, one quad for the lens, no lights, pooled + wrapped.
 */

// ---- Tunables --------------------------------------------------------------
const STREAK_COUNT = 180
const WIND_ANGLE = 0.35 // radians the streaks lean from vertical
const FADE_K = 2.2 // damp() rate for the ~2s intensity fade in/out

// The streak field lives on a virtual plane this many world-units in front of
// the camera (just inside the near plane = 0.5). Streaks are sized to over-fill
// the frustum at that depth so the screen is always covered at any aspect.
const PLANE_Z = -0.62 // camera-space Z (negative = in front)
const FIELD_HALF_W = 0.62 // half-width of the tiling field at PLANE_Z
const FIELD_HALF_H = 0.62 // half-height
const STREAK_LEN = 0.085 // long axis of a streak quad (camera-space units)
const STREAK_WID = 0.0065 // short axis (thin)
const FALL_SPEED = 1.9 // field-units / sec the streaks rain downward

// Weather schedule (seconds).
const SPELL_MIN = 20
const SPELL_MAX = 40
const GAP_MIN = 90
const GAP_MAX = 150
const RAINBOW_SECONDS = 12

// ---- module-scoped temporaries (no per-frame allocation) -------------------
const _fogCol = new THREE.Color()
const _darkFog = new THREE.Color()
// Cache the last fog hex so setClearColor is skipped when the colour hasn't changed.
let _lastWeatherFogHex = -1

interface Weather {
  raining: boolean
  rainIntensity01: number
  rainbow: boolean
}

export function createWeatherSystem(): GameSystem {
  // Owned objects (assigned in init).
  let rig: THREE.Group // parented to the camera; holds streaks + lens
  let streaks: THREE.InstancedMesh
  let streakMat: THREE.ShaderMaterial
  let lens: THREE.Mesh | null = null
  let lensMat: THREE.ShaderMaterial | null = null
  let rainDom: HTMLDivElement | null = null // DOM rain overlay — reliable on-screen streaks

  // Per-streak tiling state (parallel arrays → cache-friendly, no objects).
  const sx = new Float32Array(STREAK_COUNT) // field x in [-1,1]
  const sy = new Float32Array(STREAK_COUNT) // field y in [-1,1] (wraps)
  const sScale = new Float32Array(STREAK_COUNT) // length jitter
  const sSpeed = new Float32Array(STREAK_COUNT) // per-streak fall speed mult

  // Reused matrix/quat/scale for instance composition.
  const _m = new THREE.Matrix4()
  const _q = new THREE.Quaternion()
  const _pos = new THREE.Vector3()
  const _scl = new THREE.Vector3()
  // The streak quad is canted by the wind angle once; all instances share it.
  const _windQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    WIND_ANGLE
  )

  // Published shared state (other systems read this off the context).
  const weather: Weather = { raining: false, rainIntensity01: 0, rainbow: false }

  // Scheduler state.
  let phaseTimer = 0 // counts down within the current clear/rain phase
  let raining = false
  let target01 = 0 // 0 (clear) or 1 (raining) — the fade target
  let rainbowTimer = 0
  let sfxTimer = 0 // throttle for the looping-ish rain SFX
  let lowEnd = false

  /** Range helper on the seeded RNG. */
  function rng(ctx: GameContext, lo: number, hi: number): number {
    return lo + ctx.rand() * (hi - lo)
  }

  /** Re-seed one streak above the top of the field after it falls off bottom. */
  function recycleStreak(i: number, ctx: GameContext): void {
    sx[i] = ctx.rand() * 2 - 1
    sScale[i] = 0.7 + ctx.rand() * 0.8
    sSpeed[i] = 0.75 + ctx.rand() * 0.6
  }

  return {
    name: 'weather',

    init(ctx: GameContext) {
      // DOM rain overlay: screen-blended diagonal streaks; opacity tracks intensity.
      rainDom = document.createElement('div')
      rainDom.style.cssText =
        'position:fixed;inset:0;pointer-events:none;opacity:0;z-index:6;mix-blend-mode:screen;background-image:repeating-linear-gradient(100deg,transparent 0,transparent 7px,rgba(225,235,250,.5) 7px,rgba(225,235,250,.5) 8px,transparent 8px,transparent 15px);background-size:100% 22px;animation:sdrain .55s linear infinite;transition:opacity .4s'
      ctx.hud.root.appendChild(rainDom)
      if (!document.getElementById('sdrain-kf')) {
        const st = document.createElement('style')
        st.id = 'sdrain-kf'
        st.textContent = '@keyframes sdrain{from{background-position:0 0}to{background-position:-70px 220px}}'
        document.head.appendChild(st)
      }
      // --- camera-locked rig ---------------------------------------------
      rig = new THREE.Group()
      rig.name = 'weather'
      // Render after the world; matrices are driven by the camera parent.
      rig.renderOrder = 5
      ctx.camera.add(rig)
      // The camera itself must be in the scene graph for child overlays to draw
      // through the composer's RenderPass. main.ts adds the planeObj/world but
      // not necessarily the camera, so ensure it's attached.
      if (!ctx.camera.parent) ctx.scene.add(ctx.camera)

      // Decide quality once (cheap droplet lens only on capable devices).
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const coarse =
        typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
      lowEnd = dpr < 2 || coarse

      // --- STREAKS: one tapered-quad geometry, instanced -----------------
      // A unit quad on XY (length along Y, width along X) → the recipe's shader
      // reads vUv.y as "along" and vUv.x as "across".
      const quad = new THREE.PlaneGeometry(1, 1, 1, 1)
      streakMat = new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
        blending: THREE.NormalBlending, // normal (not additive) so streaks read on bright sky
        toneMapped: false,
        uniforms: {
          uOpacity: { value: 0 },
          uColor: { value: new THREE.Color(0.88, 0.92, 0.99) },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        // Faithful to the recipe: taper along the streak + a soft across falloff.
        fragmentShader: /* glsl */ `
          precision mediump float;
          uniform float uOpacity;
          uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            float along = vUv.y;
            float taper = smoothstep(0.0, 0.15, along) * smoothstep(1.0, 0.7, along);
            float across = abs(vUv.x - 0.5) * 2.0;
            float shape = (1.0 - smoothstep(0.0, 1.0, across)) * taper;
            gl_FragColor = vec4(uColor, shape * uOpacity);
          }
        `,
      })
      streaks = new THREE.InstancedMesh(quad, streakMat, STREAK_COUNT)
      streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      streaks.frustumCulled = false
      streaks.renderOrder = 5
      streaks.matrixAutoUpdate = false
      rig.add(streaks)

      // Seed the field: x random, y spread across the field, jittered size/speed.
      for (let i = 0; i < STREAK_COUNT; i++) {
        recycleStreak(i, ctx)
        sy[i] = ctx.rand() * 2 - 1 // already scattered top→bottom
      }

      // --- optional GLASS-DROPLET lens (full-screen procedural) ----------
      if (!lowEnd) {
        const lensGeo = new THREE.PlaneGeometry(2, 2) // covers the field plane
        lensMat = new THREE.ShaderMaterial({
          transparent: true,
          depthTest: false,
          depthWrite: false,
          fog: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
          uniforms: {
            uTime: { value: 0 },
            uOpacity: { value: 0 },
          },
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          // Cheap "drops on the lens": a few scrolling cells, each with a bright
          // rim highlight. No scene sampling (so no render-target), additive, so
          // it reads as light catching on glass beads rather than true refraction.
          fragmentShader: /* glsl */ `
            precision mediump float;
            uniform float uTime;
            uniform float uOpacity;
            varying vec2 vUv;
            float hash(vec2 p) {
              return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
            }
            void main() {
              // a sparse grid of slowly-sliding droplets
              vec2 uv = vUv * vec2(7.0, 5.0);
              uv.y += uTime * 0.18;
              vec2 cell = floor(uv);
              vec2 f = fract(uv) - 0.5;
              float r = hash(cell);
              // jitter each drop's centre + size; many cells stay empty
              f -= (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.6;
              float present = step(0.62, r);
              float d = length(f) * (1.6 + r);
              // bright thin rim = the glassy edge highlight
              float rim = smoothstep(0.42, 0.34, d) * smoothstep(0.18, 0.30, d);
              float bead = smoothstep(0.30, 0.0, d) * 0.25;
              float a = (rim * 0.8 + bead) * present;
              gl_FragColor = vec4(vec3(0.8, 0.85, 0.95) * a, a * uOpacity);
            }
          `,
        })
        lens = new THREE.Mesh(lensGeo, lensMat)
        lens.frustumCulled = false
        lens.renderOrder = 6 // in front of the streaks
        lens.matrixAutoUpdate = false
        lens.position.set(0, 0, PLANE_Z + 0.01)
        lens.scale.set(FIELD_HALF_W * 2, FIELD_HALF_H * 2, 1)
        lens.updateMatrix()
        rig.add(lens)
      }

      // Seed the scheduler: start clear, first spell after a normal gap.
      raining = false
      target01 = 0
      phaseTimer = rng(ctx, GAP_MIN, GAP_MAX)

      // Publish the shared contract immediately so first-frame readers see it.
      weather.raining = false
      weather.rainIntensity01 = 0
      weather.rainbow = false
      ;(ctx as any).weather = weather
    },

    update(dt: number, ctx: GameContext) {
      // --- scheduler: flip between clear gaps and rain spells -------------
      phaseTimer -= dt
      if (phaseTimer <= 0) {
        if (raining) {
          // Spell ends. If it's daytime, leave a rainbow for a while.
          const sky = (ctx as any).sky
          const isNight = sky ? !!sky.isNight : false
          if (!isNight) rainbowTimer = RAINBOW_SECONDS
          raining = false
          target01 = 0
          phaseTimer = rng(ctx, GAP_MIN, GAP_MAX)
        } else {
          // Clear gap ends → start a rain spell.
          raining = true
          target01 = 1
          phaseTimer = rng(ctx, SPELL_MIN, SPELL_MAX)
        }
      }

      // --- smooth fade of intensity toward the target (≈2s in/out) -------
      const k = damp(FADE_K, dt)
      weather.rainIntensity01 += (target01 - weather.rainIntensity01) * k
      if (weather.rainIntensity01 < 0.001) weather.rainIntensity01 = 0
      const inten = weather.rainIntensity01
      weather.raining = raining

      // --- rainbow countdown --------------------------------------------
      if (rainbowTimer > 0) {
        rainbowTimer -= dt
        if (rainbowTimer < 0) rainbowTimer = 0
      }
      weather.rainbow = rainbowTimer > 0

      // Republish (in case another system replaced the object reference).
      ;(ctx as any).weather = weather

      // --- skip all visual work when bone-dry ----------------------------
      streaks.visible = inten > 0.002
      if (rainDom) rainDom.style.opacity = String(Math.min(1, inten * 0.95))
      if (lens) lens.visible = inten > 0.002
      if (inten <= 0.002) {
        streakMat.uniforms.uOpacity.value = 0
        return
      }

      // --- darken the published fog ~15% while raining -------------------
      // The Sky system owns scene.fog; we only NUDGE its colour, lerping back as
      // rain clears so we never fight Sky's own day/night colour drift.
      const sky = (ctx as any).sky
      if (sky && typeof sky.fogColor === 'number') {
        _fogCol.setHex(sky.fogColor)
        _darkFog.copy(_fogCol).multiplyScalar(1 - 0.42 * inten)
        const f = ctx.scene.fog as THREE.Fog | null
        if (f && (f as any).isFog) {
          // ease toward the darkened colour; Sky will re-assert next frame and we
          // re-darken — net effect is a steady ~15% dim that tracks the cycle.
          f.color.lerp(_darkFog, damp(3.0, dt))
          const fh = f.color.getHex()
          if (fh !== _lastWeatherFogHex) {
            _lastWeatherFogHex = fh
            ctx.renderer.setClearColor(f.color, 1)
          }
        }
      }

      // --- looping-ish rain SFX (throttled; the bus has no sustained loop) -
      sfxTimer -= dt
      if (sfxTimer <= 0) {
        ctx.audio.play('rain', { volume: 0.18 + 0.22 * inten })
        sfxTimer = 1.4 + ctx.rand() * 0.9
      }

      // --- animate + advance the streak field ----------------------------
      const dy = FALL_SPEED * dt
      streakMat.uniforms.uOpacity.value = 0.9 * inten
      for (let i = 0; i < STREAK_COUNT; i++) {
        // fall downward (in field space), wrap, recycle x/size when re-entering.
        let y = sy[i] - dy * sSpeed[i]
        if (y < -1.15) {
          y += 2.3
          recycleStreak(i, ctx)
        }
        sy[i] = y

        // map field [-1,1] → camera-space position on the PLANE_Z plane
        _pos.set(sx[i] * FIELD_HALF_W, y * FIELD_HALF_H, PLANE_Z)
        const len = STREAK_LEN * sScale[i]
        _scl.set(STREAK_WID, len, 1)
        _q.copy(_windQuat)
        _m.compose(_pos, _q, _scl)
        streaks.setMatrixAt(i, _m)
      }
      streaks.instanceMatrix.needsUpdate = true

      // --- droplet lens shimmer -----------------------------------------
      if (lens && lensMat) {
        lensMat.uniforms.uTime.value = ctx.elapsed()
        // lens lags the streaks a touch + is subtler (it's the "on the canopy" cue)
        lensMat.uniforms.uOpacity.value = 0.5 * Math.max(0, inten - 0.15)
      }
    },

    dispose() {
      streaks.geometry.dispose()
      streakMat.dispose()
      if (lens) {
        lens.geometry.dispose()
        lensMat?.dispose()
      }
      rig.parent?.remove(rig)
    },
  }
}
