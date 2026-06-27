import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { createWindshieldRainPass } from './WindshieldRainPass'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — global post-processing.
//
//   RenderPass        scene → linear HDR buffer
//   UnrealBloomPass   high-threshold soft glow (only sun / gems / lanterns crest it)
//   OutputPass        three's own tone-map (reads renderer.toneMapping = AgX) + sRGB
//   WindshieldRain    LAST → refracts the final tonemapped image with rain drops
//
// OutputPass is used instead of a hand-rolled grade shader so we don't redefine
// three's AgX/colour-space chunks (that collides at compile time). The rain pass
// runs after OutputPass so it warps the finished sRGB frame (predictable highlights)
// and is the pass that renders to screen. The Weather system drives its uIntensity
// / uSpeed uniforms each frame; we keep uTime + uAspect here.
// ─────────────────────────────────────────────────────────────────────────────

export interface Composer {
  composer: EffectComposer
  /** the windshield-rain pass — main.ts publishes this so Weather can drive it */
  rainPass: ShaderPass
  setSize(w: number, h: number): void
  render(): void
}

export function createComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera
): Composer {
  const size = new THREE.Vector2()
  renderer.getSize(size)
  const dpr = Math.min(renderer.getPixelRatio(), 2)

  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(dpr)
  composer.setSize(size.x, size.y)

  composer.addPass(new RenderPass(scene, camera))

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y),
    0.3, // strength — gentle, present but not blown out
    0.45, // radius — feathered
    0.9 // threshold — HIGH so only the brightest highlights bloom
  )
  composer.addPass(bloom)

  // Tone-map (AgX, from renderer.toneMapping) + sRGB encode. No custom GLSL.
  composer.addPass(new OutputPass())

  // Windshield rain — LAST pass, refracts the finished frame, renders to screen.
  const rainPass = createWindshieldRainPass(size.x, size.y)
  composer.addPass(rainPass)

  // uTime is wall-clock driven here so the rain animates regardless of caller.
  const start = performance.now()

  return {
    composer,
    rainPass,
    setSize(w: number, h: number) {
      const d = Math.min(renderer.getPixelRatio(), 2)
      composer.setPixelRatio(d)
      composer.setSize(w, h)
      bloom.setSize(w, h)
      ;(rainPass.uniforms.uAspect.value as THREE.Vector2).set(w / Math.max(1, h), 1)
    },
    render() {
      rainPass.uniforms.uTime.value = (performance.now() - start) / 1000
      composer.render()
    },
  }
}
