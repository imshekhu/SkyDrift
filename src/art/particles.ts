import * as THREE from 'three'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — glow particles
//
// A reusable, pooled THREE.Points emitter for soft, ethereal "magical dust".
// Each particle is a canvas-baked SOFT RADIAL sprite (no asset), additively
// blended, with PER-PARTICLE size, alpha and colour driven by a tiny
// ShaderMaterial (PointsMaterial can't vary size/alpha per point). This replaces
// flat emissive quads/grids with glowing dust for weapon trails, portals, storms.
//
// Zero per-frame allocation: a fixed pool of N particles in parallel Float32Arrays;
// emit() writes a round-robin slot (O(1)); update() integrates + fades and flips
// one needsUpdate per attribute. One Points = one draw call. Inactive particles
// carry aAlpha=0 and are `discard`-ed in the fragment shader.
// ─────────────────────────────────────────────────────────────────────────────

// Soft round alpha texture — baked once on a canvas, shared by every emitter.
let _softTex: THREE.Texture | null = null
export function softParticleTexture(): THREE.Texture {
  if (_softTex) return _softTex
  const size = 64
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const g = cv.getContext('2d')!
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grd.addColorStop(0.0, 'rgba(255,255,255,1.0)')
  grd.addColorStop(0.25, 'rgba(255,255,255,0.6)')
  grd.addColorStop(0.55, 'rgba(255,255,255,0.16)')
  grd.addColorStop(1.0, 'rgba(255,255,255,0.0)')
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  _softTex = tex
  return tex
}

export interface GlowParticleOpts {
  count: number // pool size
  size?: number // default point size in world units (size-attenuated)
  drag?: number // velocity damping rate per second (exp); 0 = none
  gravityDir?: THREE.Vector3 // optional constant accel direction (e.g. toward planet centre)
  gravity?: number // magnitude of the gravity accel
  blending?: THREE.Blending // default AdditiveBlending
  renderOrder?: number
}

/**
 * A pooled THREE.Points glow emitter. Add `.points` to the scene; call `emit(...)`
 * to spawn dust and `update(dt)` once per frame. Reusable for any soft glow.
 */
export class GlowParticles {
  readonly points: THREE.Points
  private geo: THREE.BufferGeometry
  private mat: THREE.ShaderMaterial
  private readonly N: number

  // pool state (struct-of-arrays)
  private pos: Float32Array
  private vel: Float32Array
  private life: Float32Array
  private maxLife: Float32Array
  private size0: Float32Array
  // uploaded geometry attributes
  private aPos: THREE.BufferAttribute
  private aSize: THREE.BufferAttribute
  private aAlpha: THREE.BufferAttribute
  private aColor: THREE.BufferAttribute

  private cursor = 0
  private readonly drag: number
  private gx = 0
  private gy = 0
  private gz = 0
  private readonly baseSize: number

  constructor(opts: GlowParticleOpts) {
    const N = (this.N = opts.count)
    this.drag = opts.drag ?? 0
    this.baseSize = opts.size ?? 4
    if (opts.gravityDir && opts.gravity) {
      const d = opts.gravityDir.clone().normalize().multiplyScalar(opts.gravity)
      this.gx = d.x
      this.gy = d.y
      this.gz = d.z
    }

    this.pos = new Float32Array(N * 3)
    this.vel = new Float32Array(N * 3)
    this.life = new Float32Array(N)
    this.maxLife = new Float32Array(N)
    this.size0 = new Float32Array(N)

    this.geo = new THREE.BufferGeometry()
    this.aPos = new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage)
    this.aSize = new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage)
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage)
    this.aColor = new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage)
    this.geo.setAttribute('position', this.aPos)
    this.geo.setAttribute('aSize', this.aSize)
    this.geo.setAttribute('aAlpha', this.aAlpha)
    this.geo.setAttribute('aColor', this.aColor)
    // never cull (particles roam); skip bounding-sphere maths entirely
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9)

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: softParticleTexture() },
        uPixel: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true, // dust is occluded by terrain, but never occludes itself
      fog: false,
      blending: opts.blending ?? THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        uniform float uPixel;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // size-attenuated: shrinks with distance like real motes
          gl_PointSize = aSize * uPixel * (300.0 / max(0.001, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          if (vAlpha <= 0.001) discard;
          float a = texture2D(uTex, gl_PointCoord).a * vAlpha;
          gl_FragColor = vec4(vColor, a); // additive: contributes vColor * a (HDR colour blooms)
        }
      `,
    })
    this.mat.toneMapped = false

    this.points = new THREE.Points(this.geo, this.mat)
    this.points.frustumCulled = false
    if (opts.renderOrder != null) this.points.renderOrder = opts.renderOrder
  }

  /** Spawn one particle. `r,g,b` may exceed 1 (HDR) to crest the bloom threshold. */
  emit(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number, size?: number,
    r = 1, g = 1, b = 1
  ): void {
    const i = this.cursor // round-robin overwrite (oldest) — O(1), no search
    this.cursor = (i + 1) % this.N
    const o = i * 3
    this.pos[o] = px; this.pos[o + 1] = py; this.pos[o + 2] = pz
    this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz
    this.life[i] = life
    this.maxLife[i] = life
    this.size0[i] = size ?? this.baseSize
    const c = this.aColor.array as Float32Array
    c[o] = r; c[o + 1] = g; c[o + 2] = b
  }

  update(dt: number): void {
    const N = this.N
    const posA = this.aPos.array as Float32Array
    const sizeA = this.aSize.array as Float32Array
    const alphaA = this.aAlpha.array as Float32Array
    const dragF = this.drag > 0 ? Math.exp(-this.drag * dt) : 1
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) {
        alphaA[i] = 0
        continue
      }
      this.life[i] -= dt
      if (this.life[i] <= 0) {
        this.life[i] = 0
        alphaA[i] = 0
        continue
      }
      const o = i * 3
      this.vel[o] = this.vel[o] * dragF + this.gx * dt
      this.vel[o + 1] = this.vel[o + 1] * dragF + this.gy * dt
      this.vel[o + 2] = this.vel[o + 2] * dragF + this.gz * dt
      this.pos[o] += this.vel[o] * dt
      this.pos[o + 1] += this.vel[o + 1] * dt
      this.pos[o + 2] += this.vel[o + 2] * dt
      const t = this.life[i] / this.maxLife[i] // 1 → 0
      posA[o] = this.pos[o]
      posA[o + 1] = this.pos[o + 1]
      posA[o + 2] = this.pos[o + 2]
      sizeA[i] = this.size0[i] * (1 + (1 - t) * 0.6) // bloom outward as it dissipates
      alphaA[i] = t * t // soft quadratic fade-out
    }
    this.aPos.needsUpdate = true
    this.aSize.needsUpdate = true
    this.aAlpha.needsUpdate = true
    this.aColor.needsUpdate = true
  }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
    this.points.parent?.remove(this.points)
  }
}
