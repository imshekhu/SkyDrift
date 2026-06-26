import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'
import { damp } from '../plane/flight'

/**
 * The ONE light rig for the whole game. Three real lights, no more:
 *   1. DirectionalLight  — warm key "sun" (no shadow maps; mobile-cheap).
 *   2. HemisphereLight    — cool sky from above + warm ground bounce below.
 *                           The color split does the work of a rim/back light:
 *                           edges facing the sky catch a cool sheen, undersides
 *                           catch a warm bounce, so silhouettes read in 3D
 *                           without spending a third "real" rim light.
 *   3. AmbientLight       — tiny warm floor so nothing reads pure black.
 *
 * Plus a fake soft "blob" shadow: a single textured quad that follows the
 * plane, hugs the planet surface, drifts toward the anti-sun side, and
 * scales/softens with altitude. Costs one transparent draw call instead of a
 * full shadow-map pass — the right call for 60fps on iOS.
 *
 * No other system should add lights. This is intentionally the whole rig.
 */
export function createLightingSystem(): GameSystem {
  // ---- real lights ---------------------------------------------------------
  // Warm key sun: the dominant, directional, gold-cream light.
  const SUN_BASE_INTENSITY = 2.05
  const sun = new THREE.DirectionalLight(PAL.sun.getHex(), SUN_BASE_INTENSITY)
  sun.castShadow = false // fake blob shadow instead — mobile budget

  // Hemisphere fill carries the cozy ambience. Sky is cool (matches the upper
  // sky), ground bounce is a soft warm sand rather than the literal mossy green
  // — a touch of warmth on undersides keeps the pastel scene from going dull.
  const HEMI_SKY = new THREE.Color().setHex(0xbfe3f2, THREE.SRGBColorSpace) // cool, == skyHorizon
  const HEMI_GROUND = new THREE.Color().setHex(0xe7c9a0, THREE.SRGBColorSpace) // warm sand bounce
  const HEMI_BASE_INTENSITY = 0.78
  const hemi = new THREE.HemisphereLight(HEMI_SKY.getHex(), HEMI_GROUND.getHex(), HEMI_BASE_INTENSITY)

  // Whisper-quiet warm floor so shadows never crush to black.
  const ambient = new THREE.AmbientLight(0xfff4e6, 0.14)

  // Warm "afternoon" tint we drift the sun toward and back, very subtly.
  const SUN_COOL = new THREE.Color().setHex(0xfff2d6, THREE.SRGBColorSpace) // midday cream
  const SUN_WARM = new THREE.Color().setHex(0xffe0b8, THREE.SRGBColorSpace) // golden hour

  // ---- blob shadow ---------------------------------------------------------
  const BLOB_SIZE = 13 // world units; a touch larger than the plane footprint
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(BLOB_SIZE, BLOB_SIZE),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.7,
      depthWrite: false, // never occlude; it's a decal
      color: 0xffffff, // texture carries the (slightly cool) shadow tint
      map: null as unknown as THREE.Texture,
    }),
  )
  blob.renderOrder = 2 // draw after opaque surface + water
  blob.matrixAutoUpdate = true
  blob.frustumCulled = false // it's always near the camera; skip the cull test

  // Soft radial-gradient texture (built once, cached). A faint cool-blue tint
  // instead of pure black reads as a believable sky-lit shadow on pastel grass,
  // not a harsh hole. Multiple stops give a gentle, feathered penumbra.
  function makeBlobTexture(): THREE.Texture {
    const S = 128
    const cv = document.createElement('canvas')
    cv.width = cv.height = S
    const g = cv.getContext('2d')!
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
    // Slightly desaturated indigo core → transparent edge. Alpha does the fade.
    grad.addColorStop(0.0, 'rgba(38,44,66,0.62)')
    grad.addColorStop(0.4, 'rgba(40,48,70,0.42)')
    grad.addColorStop(0.72, 'rgba(44,52,74,0.18)')
    grad.addColorStop(1.0, 'rgba(48,56,80,0.0)')
    g.fillStyle = grad
    g.fillRect(0, 0, S, S)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    tex.needsUpdate = true
    return tex
  }

  // ---- module-scoped temps (zero per-frame allocation) ---------------------
  const _up = new THREE.Vector3() // plane's radial-up direction
  const _surf = new THREE.Vector3() // surface point under the plane
  const _q = new THREE.Quaternion() // orient blob to surface
  const _yAxis = new THREE.Vector3(0, 1, 0)
  const _sunDir = new THREE.Vector3()
  const _sunOffset = new THREE.Vector3()
  const _toSun = new THREE.Vector3() // world dir from plane toward the sun
  const _drift = new THREE.Vector3() // tangential anti-sun offset for the blob
  const _tmp = new THREE.Vector3()

  // The fixed world-space side offset that gives the sun its pleasant angle.
  const SUN_SIDE = new THREE.Vector3(120, 0, 80)

  return {
    name: 'lighting',

    init(ctx: GameContext) {
      const blobTex = makeBlobTexture()
      ;(blob.material as THREE.MeshBasicMaterial).map = blobTex
      ;(blob.material as THREE.MeshBasicMaterial).needsUpdate = true

      // Warm key from up-and-to-the-side, repositioned each frame to keep its
      // angle relative to the plane stable everywhere on the globe.
      sun.position.set(120, 180, 80)
      sun.target.position.set(0, 0, 0)

      hemi.position.set(0, 1, 0)

      ctx.scene.add(sun)
      ctx.scene.add(sun.target)
      ctx.scene.add(hemi)
      ctx.scene.add(ambient)
      ctx.scene.add(blob)

      // place the blob once so frame 0 doesn't pop
      this.update(0, ctx)
    },

    update(dt: number, ctx: GameContext) {
      const p = ctx.player.obj.position
      _up.copy(p).normalize()

      // --- keep the key light's relative angle stable as we roam -----------
      // DirectionalLight only cares about direction, but anchoring it a fixed
      // offset above the plane keeps the lit side consistent across the globe.
      _sunDir.copy(_up).multiplyScalar(180)
      _sunOffset.copy(SUN_SIDE)
      sun.position.copy(p).add(_sunDir).add(_sunOffset)
      sun.target.position.copy(p)

      // World-space direction from the plane toward the sun (for shadow drift).
      _toSun.copy(sun.position).sub(p).normalize()

      // --- blob shadow: ride the surface, drift to the anti-sun side -------
      // Project the anti-sun direction onto the local tangent plane so the
      // shadow slides "downhill from the light" the way a real one would,
      // instead of sitting dead-center under the plane.
      _drift.copy(_toSun).negate()
      _drift.addScaledVector(_up, -_drift.dot(_up)) // remove radial component → tangent
      const driftLen = _drift.length()
      if (driftLen > 1e-4) _drift.multiplyScalar(1 / driftLen)
      else _drift.set(0, 0, 0)

      const alt = ctx.player.flight.altitude
      const t = THREE.MathUtils.clamp(alt / 90, 0, 1)
      // Higher up → shadow drifts a little further out and trails the plane.
      const driftDist = THREE.MathUtils.lerp(0.6, 3.2, t)

      // Surface point under the (drifted) plane, lifted a hair to avoid z-fight.
      _tmp.copy(_up).addScaledVector(_drift, driftDist * 0.012) // tiny angular nudge
      _surf.copy(ctx.planet.surfacePoint(_tmp, 0.06))
      blob.position.copy(_surf)

      // Lay the quad flat on the sphere: PlaneGeometry faces +Z, _FLAT tilts
      // that normal to +Y, then _q aligns +Y to the local surface normal.
      _q.setFromUnitVectors(_yAxis, _up)
      blob.quaternion.copy(_q).multiply(_FLAT)

      // Fade & shrink the shadow with altitude (higher = softer, smaller).
      // Smoothstep so the change feels organic near the ground.
      const ts = t * t * (3 - 2 * t)
      const scale = THREE.MathUtils.lerp(1.05, 0.5, ts)
      blob.scale.setScalar(scale)
      const mat = blob.material as THREE.MeshBasicMaterial
      const targetOpacity = THREE.MathUtils.lerp(0.74, 0.1, ts)
      mat.opacity += (targetOpacity - mat.opacity) * damp(8, dt)

      // --- living sky: gentle warm/cool breathing ---------------------------
      const e = ctx.elapsed()
      // Slow ~42s cycle between cream midday and a hint of golden hour.
      const warm = 0.5 + 0.5 * Math.sin(e * 0.15)
      sun.color.copy(SUN_COOL).lerp(SUN_WARM, warm * 0.6)
      sun.intensity = SUN_BASE_INTENSITY + (warm - 0.5) * 0.18

      // The fill breathes in counterpoint: as the key warms, the cool sky fill
      // eases up a touch so the overall exposure stays steady and cozy.
      hemi.intensity = HEMI_BASE_INTENSITY - (warm - 0.5) * 0.06
    },

    dispose() {
      sun.removeFromParent()
      sun.target.removeFromParent()
      hemi.removeFromParent()
      ambient.removeFromParent()
      blob.removeFromParent()
      blob.geometry.dispose()
      const mat = blob.material as THREE.MeshBasicMaterial
      mat.map?.dispose()
      mat.dispose()
    },
  }
}

// Tilt that turns PlaneGeometry's +Z normal into +Y (so the quad lies flat
// before we align it to the surface). Module-scoped const — built once.
const _FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
