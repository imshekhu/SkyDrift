import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — global post-processing.
//
//   RenderPass        scene → linear HDR buffer
//   UnrealBloomPass   high-threshold soft glow (only sun / gems / lanterns crest it)
//   OutputPass        three's own tone-map (reads renderer.toneMapping = AgX) + sRGB
//
// OutputPass is used instead of a hand-rolled grade shader so we don't redefine
// three's AgX/colour-space chunks (that collides at compile time). A soft vignette
// is applied cheaply in CSS (see style.css) rather than a 3rd full-screen pass.
// ─────────────────────────────────────────────────────────────────────────────

export interface Composer {
  composer: EffectComposer
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

  // Final tone-map (AgX, from renderer.toneMapping) + sRGB encode. No custom GLSL.
  composer.addPass(new OutputPass())

  return {
    composer,
    setSize(w: number, h: number) {
      const d = Math.min(renderer.getPixelRatio(), 2)
      composer.setPixelRatio(d)
      composer.setSize(w, h)
      bloom.setSize(w, h)
    },
    render() {
      composer.render()
    },
  }
}
