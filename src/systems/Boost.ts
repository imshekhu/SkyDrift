import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { TUNING, damp } from '../plane/flight'
import { PAL } from '../art/palette'

/**
 * Boost.ts — Boost as a CONSUMABLE resource, with JUICE.
 *
 * METER
 * - A boost meter (0..1) drains while ctx.input.boost is held AND meter > 0,
 *   and regenerates (after a short cooldown) otherwise.
 * - Boost is only *allowed* when the meter has charge. We expose the gate via
 *   (ctx as any).boostActive so the rest of the world (camera, audio, FX) can
 *   read a single source of truth, and we also force ctx.input.boost = false
 *   when the meter is empty so Flight stops accelerating.
 * - Respects (ctx as any).upgrades.boostCap (a multiplier on capacity/regen).
 * - Emits "boost" { active } only on edges (start/stop), never per-frame.
 *
 * JUICE (all read from a single smooth `punch` envelope 0..1)
 * - FOV PUNCH: a strong-but-smooth extra widen on top of the chase-cam's own
 *   boost FOV. We can't write cam.fov in update() — the chase cam overwrites it
 *   AFTER us every frame — so we wrap cam.updateProjectionMatrix() (which the
 *   chase cam calls last) and fold our punch in right before the matrix bakes.
 * - CAMERA SHAKE: a tiny high-frequency positional jitter, injected by wrapping
 *   cam.updateMatrixWorld() (the renderer calls it AFTER the chase cam parks the
 *   camera), so the rig never clobbers it. Decays the instant boost ends.
 * - SPEED LINES: a single InstancedMesh of additive streaks screaming past the
 *   eye, denser/brighter at full punch.
 * - EXHAUST FLARE: a small additive billboard pinned behind the plane's tail,
 *   warm-coral, that flares up while boosting.
 * - WHOOSH: ctx.audio.play("boost") on the rising edge.
 *
 * Mobile-perf: one InstancedMesh (no per-streak draws), one flare sprite, one
 * tiny HUD overlay, and ZERO allocation in update(). Method wrappers are
 * installed once in init() and fully restored in dispose().
 */
export function createBoostSystem(): GameSystem {
  // ----- tuning (module-local; not exported to keep the contract clean) -----
  const DRAIN_PER_SEC = 0.42 // full meter lasts ~2.4s of boost at base cap
  const REGEN_PER_SEC = 0.22 // ~4.5s to fully recharge at base cap
  const REGEN_DELAY = 0.6 // seconds to wait after boosting before regen starts
  const MIN_TO_ENGAGE = 0.06 // need a little charge before a fresh boost can start
  const PUNCH_RISE = 9.0 // how fast the juice envelope ramps up (snappy)
  const PUNCH_FALL = 5.5 // how fast it eases back down (a touch slower → satisfying)

  const FOV_PUNCH = 7 // extra degrees of widen at full punch (on top of cam rig)
  const SHAKE_AMP = 0.085 // world-units of positional camera jitter at full punch
  const SHAKE_FREQ = 34 // Hz-ish of the jitter wobble

  const STREAK_COUNT = 30 // capped particle budget (mobile-friendly)
  const STREAK_RADIUS = 9 // how far off the camera axis streaks spawn
  const STREAK_LEN = 7 // streak length along view axis
  const STREAK_SPEED = 108 // how fast streaks fly toward the camera
  const STREAK_NEAR = 3 // recycle once a streak passes this close
  const STREAK_FAR = 46 // spawn this far ahead along the view axis

  // ----- meter state -----
  let meter = 1
  let active = false // are we *actually* boosting this frame?
  let prevActive = false
  let sinceBoost = REGEN_DELAY // time since boost released (gates regen)
  let punch = 0 // 0..1 smooth juice envelope (drives ALL fx)
  let shakePhase = 0 // advances only while boosting

  // ----- HUD meter (tiny, GPU-cheap; updated by scaleX %, not redrawn) -----
  let hudWrap: HTMLDivElement | null = null
  let hudFill: HTMLDivElement | null = null
  let hudGlow: HTMLDivElement | null = null
  let hudShownLow = false

  // ----- speed-line streaks (one InstancedMesh, additive, no lighting) -----
  let streaks: THREE.InstancedMesh | null = null
  let streakMat: THREE.MeshBasicMaterial | null = null
  let streakGeo: THREE.BufferGeometry | null = null
  // Each streak's local offset & progress live in flat arrays — no per-frame GC.
  const offX = new Float32Array(STREAK_COUNT)
  const offY = new Float32Array(STREAK_COUNT)
  const dist = new Float32Array(STREAK_COUNT) // distance ahead along view axis
  const wobble = new Float32Array(STREAK_COUNT) // tiny phase for life variety

  // ----- exhaust flare (single additive billboard behind the tail) -----
  let flare: THREE.Sprite | null = null
  let flareMat: THREE.SpriteMaterial | null = null
  let flareTex: THREE.Texture | null = null

  // ----- camera method wrappers (installed in init, restored in dispose) -----
  let cam: THREE.PerspectiveCamera | null = null
  let origUpdateProj: (() => void) | null = null
  let origUpdateMatrixWorld: ((force?: boolean) => void) | null = null
  let fovBias = 0 // extra degrees to fold in just before the projection bakes
  let shakeX = 0 // transient world-space camera offset, reapplied each frame
  let shakeY = 0

  // ----- module-scoped temps (reused every frame; ZERO allocation in update) -----
  const _camPos = new THREE.Vector3()
  const _camQuat = new THREE.Quaternion()
  const _fwd = new THREE.Vector3()
  const _right = new THREE.Vector3()
  const _up = new THREE.Vector3()
  const _pos = new THREE.Vector3()
  const _scale = new THREE.Vector3()
  const _mat = new THREE.Matrix4()
  const _quat = new THREE.Quaternion()
  const _color = new THREE.Color()
  const _tail = new THREE.Vector3()

  function capMul(ctx: GameContext): number {
    const up = (ctx as any).upgrades
    const cap = up && typeof up.boostCap === 'number' ? up.boostCap : 1
    // clamp to something sane so a runaway upgrade can't break pacing
    return THREE.MathUtils.clamp(cap, 0.5, 4)
  }

  function seedStreak(i: number, ctx: GameContext) {
    // random point on a disc facing the camera, placed somewhere ahead
    const a = ctx.rand() * Math.PI * 2
    const r = STREAK_RADIUS * (0.25 + ctx.rand() * 0.75)
    offX[i] = Math.cos(a) * r
    offY[i] = Math.sin(a) * r
    dist[i] = STREAK_NEAR + ctx.rand() * (STREAK_FAR - STREAK_NEAR)
    wobble[i] = ctx.rand() * Math.PI * 2
  }

  // soft radial sprite (warm core → transparent edge) for the exhaust flare
  function makeFlareTexture(): THREE.Texture {
    const S = 64
    const cv = document.createElement('canvas')
    cv.width = cv.height = S
    const g = cv.getContext('2d')!
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
    grad.addColorStop(0.0, 'rgba(255,247,230,1)')
    grad.addColorStop(0.35, 'rgba(255,209,102,0.9)') // plane-wing yellow core
    grad.addColorStop(0.7, 'rgba(255,107,94,0.35)') // plane-body coral falloff
    grad.addColorStop(1.0, 'rgba(255,107,94,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, S, S)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  return {
    name: 'boost',

    init(ctx: GameContext) {
      cam = ctx.camera

      // --- HUD meter -------------------------------------------------------
      const wrap = document.createElement('div')
      wrap.style.cssText = [
        'position:absolute',
        'left:50%',
        'bottom:calc(env(safe-area-inset-bottom,0px) + 22px)',
        'transform:translateX(-50%)',
        'width:min(42vw,220px)',
        'height:8px',
        'border-radius:6px',
        'background:rgba(255,255,255,0.16)',
        'box-shadow:0 1px 4px rgba(0,0,0,0.18) inset',
        'overflow:hidden',
        'pointer-events:none',
        'backdrop-filter:blur(2px)',
        'transition:opacity 0.35s ease, box-shadow 0.15s ease',
        'opacity:0.85',
      ].join(';')

      const fill = document.createElement('div')
      const warm = '#' + PAL.planeWing.getHexString() // cozy yellow, matches plane wing
      const coral = '#' + PAL.planeBody.getHexString()
      fill.style.cssText = [
        'position:absolute',
        'inset:0',
        'border-radius:6px',
        `background:linear-gradient(90deg, ${warm}, ${coral})`,
        'transform-origin:left center',
        'transform:scaleX(1)',
        'transition:background 0.2s ease',
      ].join(';')

      // a moving sheen that races across the bar while boosting (cheap, GPU comp)
      const glow = document.createElement('div')
      glow.style.cssText = [
        'position:absolute',
        'inset:0',
        'border-radius:6px',
        'background:linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 100%)',
        'transform:translateX(-100%)',
        'opacity:0',
        'mix-blend-mode:screen',
      ].join(';')

      wrap.appendChild(fill)
      wrap.appendChild(glow)
      ctx.hud.root.appendChild(wrap)
      hudWrap = wrap
      hudFill = fill
      hudGlow = glow

      // --- speed-line streaks ---------------------------------------------
      // A thin tapered quad; additive + no depth-write so it reads as light.
      const geo = new THREE.PlaneGeometry(0.16, STREAK_LEN, 1, 1)
      // pivot at the near end so scaling Y stretches "back" toward the camera
      geo.translate(0, STREAK_LEN * 0.5, 0)
      streakGeo = geo

      const mat = new THREE.MeshBasicMaterial({
        color: PAL.skyHorizon, // soft pastel white-blue → cozy, not harsh
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        toneMapped: false,
        side: THREE.DoubleSide,
        fog: false,
      })
      streakMat = mat

      const inst = new THREE.InstancedMesh(geo, mat, STREAK_COUNT)
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      inst.frustumCulled = false // they live right around the camera anyway
      inst.renderOrder = 999 // draw late (overlay-ish); additive needs the scene first
      inst.visible = false
      inst.count = STREAK_COUNT
      // per-instance color for subtle variation; keep them all pastel-light
      inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(STREAK_COUNT * 3), 3)
      _color.copy(PAL.skyHorizon)
      for (let i = 0; i < STREAK_COUNT; i++) {
        seedStreak(i, ctx)
        const tint = 0.85 + ctx.rand() * 0.15
        inst.setColorAt(i, _color.clone().multiplyScalar(tint))
      }
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      ctx.scene.add(inst)
      streaks = inst

      // --- exhaust flare (pinned behind the tail each frame) ---------------
      flareTex = makeFlareTexture()
      const fmat = new THREE.SpriteMaterial({
        map: flareTex,
        color: PAL.planeWing,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        toneMapped: false,
        fog: false,
        rotation: 0,
      })
      flareMat = fmat
      const sprite = new THREE.Sprite(fmat)
      sprite.scale.setScalar(0.001)
      sprite.frustumCulled = false
      sprite.renderOrder = 998
      sprite.visible = false
      ctx.scene.add(sprite)
      flare = sprite

      // --- camera wrappers: let our FOV punch + shake survive the chase cam --
      // updateChaseCamera() runs AFTER this system and overwrites cam.fov,
      // position and quaternion. We hook the two methods it / the renderer call
      // LAST so our juice rides on top of the settled camera instead of fighting it.
      origUpdateProj = ctx.camera.updateProjectionMatrix.bind(ctx.camera)
      const camRef = ctx.camera
      camRef.updateProjectionMatrix = function () {
        if (fovBias !== 0) {
          camRef.fov += fovBias // fold the punch in just before the matrix bakes
          origUpdateProj!()
          camRef.fov -= fovBias // leave the rig's own fov value untouched
        } else {
          origUpdateProj!()
        }
      }

      // The renderer calls camera.updateMatrixWorld() during render(), after the
      // chase cam parks position/quaternion → inject a transient view-space shake.
      origUpdateMatrixWorld = ctx.camera.updateMatrixWorld.bind(ctx.camera)
      camRef.updateMatrixWorld = function (force?: boolean) {
        if (shakeX !== 0 || shakeY !== 0) {
          // offset along the camera's own right/up so the jitter is screen-aligned
          camRef.position.x += camRef.matrix.elements[0] * shakeX + camRef.matrix.elements[4] * shakeY
          camRef.position.y += camRef.matrix.elements[1] * shakeX + camRef.matrix.elements[5] * shakeY
          camRef.position.z += camRef.matrix.elements[2] * shakeX + camRef.matrix.elements[6] * shakeY
          origUpdateMatrixWorld!(force)
          camRef.position.x -= camRef.matrix.elements[0] * shakeX + camRef.matrix.elements[4] * shakeY
          camRef.position.y -= camRef.matrix.elements[1] * shakeX + camRef.matrix.elements[5] * shakeY
          camRef.position.z -= camRef.matrix.elements[2] * shakeX + camRef.matrix.elements[6] * shakeY
        } else {
          origUpdateMatrixWorld!(force)
        }
      }
    },

    update(dt: number, ctx: GameContext) {
      const cap = capMul(ctx)

      // ---- desire vs. availability ----
      const wantBoost = ctx.input.boost
      // Allow boosting whenever held and there's any charge, but require a small
      // threshold to *re-engage* from empty (so you can't flutter at 0).
      let nextActive = false
      if (wantBoost) {
        if (active) nextActive = meter > 0
        else nextActive = meter >= MIN_TO_ENGAGE
      }

      // ---- meter integrate ----
      if (nextActive) {
        meter -= (DRAIN_PER_SEC / cap) * dt
        sinceBoost = 0
        if (meter <= 0) {
          meter = 0
          nextActive = false // ran dry this very frame
        }
      } else {
        sinceBoost += dt
        if (sinceBoost >= REGEN_DELAY) {
          // a gentle late-game "second wind": regen speeds up the longer you wait
          meter += (REGEN_PER_SEC / cap) * dt * (sinceBoost > REGEN_DELAY + 0.8 ? 1.4 : 1)
          if (meter > 1) meter = 1
        }
      }

      active = nextActive

      // Publish the authoritative boost flag for other systems (camera/audio/hud/trails).
      // Flight's SPEED is now throttle-driven (not input.boost-driven), so we no longer
      // force input.boost = false here; the meter simply gates the boost FX + trail.
      ;(ctx as any).boostActive = active

      // ---- forward impulse on top of Flight's own speed ramp (snappier kick) ----
      if (active) {
        _fwd.set(0, 0, 1).applyQuaternion(ctx.player.obj.quaternion)
        // gentle additive nudge; Flight already ramps speed toward BOOST_SPEED.
        const kick = (TUNING.BOOST_SPEED - TUNING.CRUISE_SPEED) * 0.18
        ctx.player.obj.position.addScaledVector(_fwd, kick * dt)
      }

      // ---- edge-triggered events + sfx (whoosh on the rising edge) ----
      if (active !== prevActive) {
        ctx.events.emit('boost', { active })
        if (active) {
          // pitch the whoosh up a touch when the tank is fuller → reads as "stronger"
          ctx.audio.play('boost', { volume: 0.78, rate: 0.94 + meter * 0.18 })
        }
        prevActive = active
      }

      // ---- single smooth JUICE envelope (asymmetric: snappy in, eased out) ----
      const target = active ? 1 : 0
      punch += (target - punch) * damp(active ? PUNCH_RISE : PUNCH_FALL, dt)
      if (punch < 0.0008) punch = 0
      const eased = punch * punch * (3 - 2 * punch) // smoothstep → meaty feel

      // ---- camera FOV punch (folded in by the wrapped updateProjectionMatrix) ----
      // The chase cam already widens to CAM_FOV_BOOST; we add an extra kick on top.
      fovBias = eased * FOV_PUNCH

      // ---- camera shake (injected by the wrapped updateMatrixWorld) ----
      if (eased > 0.001) {
        shakePhase += dt * SHAKE_FREQ
        const amp = SHAKE_AMP * eased
        // two detuned sines → organic, non-repeating wobble (no RNG, no alloc)
        shakeX = (Math.sin(shakePhase) * 0.7 + Math.sin(shakePhase * 1.7 + 1.3) * 0.3) * amp
        shakeY = (Math.sin(shakePhase * 1.3 + 0.6) * 0.7 + Math.sin(shakePhase * 2.3) * 0.3) * amp
      } else {
        shakeX = 0
        shakeY = 0
      }

      // ---- HUD meter (cheap: scaleX + color, no layout thrash) ----
      if (hudFill && hudWrap) {
        hudFill.style.transform = 'scaleX(' + meter.toFixed(3) + ')'
        const low = meter < 0.18
        if (low !== hudShownLow) {
          hudShownLow = low
          // dim the bar when nearly empty so the player feels the constraint
          hudWrap.style.opacity = low ? '0.55' : '0.85'
        }
        // glow the whole bar harder the deeper we are into a boost
        if (eased > 0.001) {
          const g = (0.35 + eased * 0.45).toFixed(2)
          hudWrap.style.boxShadow =
            `0 0 ${(8 + eased * 12).toFixed(0)}px rgba(255,209,102,${g}), 0 1px 4px rgba(0,0,0,0.18) inset`
        } else {
          hudWrap.style.boxShadow = '0 1px 4px rgba(0,0,0,0.18) inset'
        }
        // racing sheen: sweep a highlight across the bar while boosting
        if (hudGlow) {
          if (eased > 0.02) {
            const sweep = ((ctx.elapsed() * 0.9) % 1) * 200 - 100 // -100%..+100%
            hudGlow.style.transform = 'translateX(' + sweep.toFixed(1) + '%)'
            hudGlow.style.opacity = (eased * 0.8).toFixed(2)
          } else if (hudGlow.style.opacity !== '0') {
            hudGlow.style.opacity = '0'
          }
        }
      }

      // ---- speed lines ----
      if (streaks && streakMat) {
        const visible = eased > 0.01
        streaks.visible = visible
        if (visible) {
          streakMat.opacity = eased * 0.62

          // build a camera-locked frame once per frame
          ctx.camera.getWorldPosition(_camPos)
          ctx.camera.getWorldQuaternion(_camQuat)
          _fwd.set(0, 0, -1).applyQuaternion(_camQuat) // camera looks down -Z
          _right.set(1, 0, 0).applyQuaternion(_camQuat)
          _up.set(0, 1, 0).applyQuaternion(_camQuat)

          // orient every streak to lie along the view axis, pointing "back"
          // (local +Y of the quad → world fwd so it stretches toward the eye)
          _mat.identity()
          _mat.makeBasis(_right, _fwd, _up) // quad's +Y maps to view-forward
          _quat.setFromRotationMatrix(_mat)

          const t = ctx.elapsed()
          // faster streaks the deeper into the punch → speed READS as speed
          const speed = STREAK_SPEED * (0.7 + eased * 0.6)
          for (let i = 0; i < STREAK_COUNT; i++) {
            // fly toward the camera
            dist[i] -= speed * dt
            if (dist[i] <= STREAK_NEAR) {
              // recycle to the far plane with fresh jitter (no allocation)
              dist[i] = STREAK_FAR - (STREAK_NEAR - dist[i])
              const a = ((i * 2.39996) + t * 0.7) % (Math.PI * 2)
              const r = STREAK_RADIUS * (0.25 + ((i * 7) % 11) / 14)
              offX[i] = Math.cos(a) * r
              offY[i] = Math.sin(a) * r
            }

            const d = dist[i]
            // position = camPos + fwd*d + right*offX + up*offY
            _pos.copy(_camPos)
            _pos.addScaledVector(_fwd, d)
            const ox = offX[i]
            const oy = offY[i] + Math.sin(t * 3 + wobble[i]) * 0.25
            _pos.addScaledVector(_right, ox)
            _pos.addScaledVector(_up, oy)

            // fade per-streak: dim near the camera & far away → soft endpoints
            const nearF = THREE.MathUtils.smoothstep(d, STREAK_NEAR, STREAK_NEAR + 8)
            const farF = 1 - THREE.MathUtils.smoothstep(d, STREAK_FAR - 12, STREAK_FAR)
            // longer streaks at deeper punch → motion-blur feel
            const lifeScale = (0.6 + Math.min(nearF, farF) * 0.9) * (0.85 + eased * 0.5)
            _scale.set(1, lifeScale, 1)

            _mat.compose(_pos, _quat, _scale)
            streaks.setMatrixAt(i, _mat)
          }
          streaks.instanceMatrix.needsUpdate = true
        }
      }

      // ---- exhaust flare (pinned behind the plane's tail, flares with punch) ----
      if (flare && flareMat) {
        const vis = eased > 0.01
        flare.visible = vis
        if (vis) {
          // tail point = a little behind the nose direction (nose is local +Z)
          _fwd.set(0, 0, 1).applyQuaternion(ctx.player.obj.quaternion)
          _tail.copy(ctx.player.obj.position).addScaledVector(_fwd, -2.0)
          flare.position.copy(_tail)
          // flicker so the flame feels alive (cheap sine, no RNG)
          const flick = 0.82 + Math.sin(ctx.elapsed() * 38) * 0.12 + Math.sin(ctx.elapsed() * 23) * 0.06
          flare.scale.setScalar((1.6 + eased * 2.4) * flick)
          flareMat.opacity = eased * 0.9 * flick
        }
      }
    },

    dispose() {
      // restore the camera methods we wrapped (leave the camera exactly as found)
      if (cam && origUpdateProj) cam.updateProjectionMatrix = origUpdateProj
      if (cam && origUpdateMatrixWorld) cam.updateMatrixWorld = origUpdateMatrixWorld
      origUpdateProj = null
      origUpdateMatrixWorld = null
      fovBias = 0
      shakeX = 0
      shakeY = 0
      cam = null

      if (streaks) {
        streaks.parent?.remove(streaks)
        streaks.dispose()
        streaks = null
      }
      streakGeo?.dispose()
      streakMat?.dispose()
      streakGeo = null
      streakMat = null

      if (flare) {
        flare.parent?.remove(flare)
        flare = null
      }
      flareMat?.dispose()
      flareTex?.dispose()
      flareMat = null
      flareTex = null

      if (hudWrap && hudWrap.parentElement) hudWrap.parentElement.removeChild(hudWrap)
      hudWrap = null
      hudFill = null
      hudGlow = null
    },
  }
}
