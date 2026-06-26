import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'
import { damp } from '../plane/flight'

/**
 * WorldsPortals — a glowing swirling ring PORTAL on the planet that, when you
 * fly through it, performs a smooth full-screen FADE transition and cross-fades
 * the whole world into a distinct second "Cosmic Drift" MOOD (same planet, new
 * skin). Fly back through the return portal to come home to the cozy dusk world.
 *
 * Faithful-but-original take on the TinySkies "portal to another world":
 *  - A low-poly TORUS ring stands UP off the ground. Its doorway is filled with
 *    a procedural shimmer disc: a deep swirling vortex + bright event-horizon
 *    rim + drifting chromatic energy — all animated in-shader (zero CPU). A ring
 *    of orbiting energy motes (ONE InstancedMesh) circles the doorway for juice.
 *    A second RETURN portal lives elsewhere and only arms once you are cosmic.
 *  - Approaching an armed portal CHARGES it: the disc brightens, the ring pulses
 *    faster and an attract halo swells — clear game-feel feedback before travel.
 *  - Passing through the ring plane (sign-flip of the player's signed distance
 *    while inside the doorway radius) kicks off a full-screen FADE overlay in
 *    ctx.hud.root (procedural radial wash + soft vignette flash) and, at the
 *    opaque midpoint, swaps the cosmic mood — a seamless skin change.
 *  - The cosmic mood is a SKIN swap, not a new scene:
 *      • a big cosmic dome (deep indigo gradient + baked twinkle) drawn IN FRONT
 *        of the normal sky dome so it fully occludes it — Sky.ts is untouched;
 *      • a layered additive STARFIELD (one Points draw call) that slowly drifts
 *        and twinkles, plus a few soft nebula sprites for depth and colour;
 *      • scene.fog colour + renderer clear colour are tinted cosmic each frame
 *        while active (best-effort; the dome guarantees the look regardless of
 *        system update order), and the discovered lights are cooled/dimmed.
 *  - Emits 'enterWorld' {id:'cosmic'|'home'} so other systems can react.
 *
 * Mobile budget: two rings, one InstancedMesh of motes, one starfield Points,
 * a few nebula sprites, one cosmic dome. No real lights added (we only *drive*
 * the existing ones, like Sky does). Zero per-frame allocation in update().
 */

// ---- Tunables --------------------------------------------------------------
const RING_INNER = 6 // torus tube hole radius (the "doorway")
const RING_TUBE = 1.2 // torus tube thickness
const RING_ALT = RING_INNER + 2 // lift centre so the doorway clears the ground
const PASS_RADIUS = RING_INNER + RING_TUBE // how close to centre counts as "through"
const FADE_SECONDS = 0.5 // half of a there-and-back fade
const STAR_COUNT = 1100 // additive points (cheap)
const DOME_RADIUS = 1180 // < camera far (1400); recentred on camera each frame
const MOTE_COUNT = 14 // orbiting energy motes per portal (one InstancedMesh)
const ARM_RANGE = 46 // distance at which a portal starts to "charge"
const ARM_RANGE2 = ARM_RANGE * ARM_RANGE

// Cosmic palette derived from PAL so it still feels part of this world.
const _cosTopBase = PAL.skyTop.clone().lerp(new THREE.Color(0x140a2e), 0.82)
const _cosHorBase = PAL.gem.clone().lerp(new THREE.Color(0x241152), 0.7)
const _cosFog = _cosHorBase.clone().lerp(new THREE.Color(0x0a0620), 0.55)

// ---- Module-scoped temporaries — zero per-frame allocation -----------------
const _camWorld = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _playerPos = new THREE.Vector3()
const _toPlayer = new THREE.Vector3()
const _v0 = new THREE.Vector3()
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _domeUp = new THREE.Vector3(0, 1, 0)
const _fogA = new THREE.Color()
const _moteMat = new THREE.Matrix4()
const _motePos = new THREE.Vector3()
const _moteQuat = new THREE.Quaternion()
const _moteScale = new THREE.Vector3()
const _colTmp = new THREE.Color()

const TWO_PI = Math.PI * 2

/** One portal placed on the surface, with a precomputed pass-through plane. */
interface Portal {
  group: THREE.Group
  ringMat: THREE.MeshStandardMaterial
  discMat: THREE.ShaderMaterial
  motes: THREE.InstancedMesh
  haloMat: THREE.SpriteMaterial
  right: THREE.Vector3 // doorway-plane right axis (for mote orbit)
  upAxis: THREE.Vector3 // doorway-plane up axis (== surface normal)
  center: THREE.Vector3 // world centre of the doorway
  normal: THREE.Vector3 // unit doorway facing (== surface tangent the ring faces)
  prevSide: number // sign of last signed distance (for crossing detection)
  primed: boolean // becomes true once the player has been near at least once
  charge: number // 0..1 proximity charge (smoothed) — drives the juice
}

/** Build two perpendicular unit tangents to n (into out1,out2). */
function makeTangents(n: THREE.Vector3, out1: THREE.Vector3, out2: THREE.Vector3): void {
  const ref = Math.abs(n.y) < 0.99 ? _up : _v2.set(1, 0, 0)
  out1.crossVectors(ref, n).normalize()
  out2.crossVectors(n, out1).normalize()
}

/** Soft radial CanvasTexture used for nebula / halo / star sprites (no assets). */
function makeRadialTexture(): THREE.CanvasTexture {
  const size = 128
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const g = cv.getContext('2d')!
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grd.addColorStop(0.0, 'rgba(255,255,255,0.9)')
  grd.addColorStop(0.28, 'rgba(255,255,255,0.34)')
  grd.addColorStop(0.65, 'rgba(255,255,255,0.08)')
  grd.addColorStop(1.0, 'rgba(255,255,255,0.0)')
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

export function createPortalsSystem(): GameSystem {
  // Owned objects (assigned in init).
  let portals: Portal[] = []
  let portalGroup: THREE.Group // holds both ring portals (always visible)
  let sharedRadialTex: THREE.Texture // shared by halos/nebulae/stars (one upload)

  // Cosmic mood layer (toggled on/off).
  let cosmic: THREE.Group
  let dome: THREE.Mesh
  let domeMat: THREE.ShaderMaterial
  let stars: THREE.Points
  let starMat: THREE.PointsMaterial
  let nebulae: THREE.Sprite[] = []
  let nebulaMats: THREE.SpriteMaterial[] = []

  // Fullscreen fade overlay (in HUD root).
  let overlay: HTMLDivElement | null = null
  let flash: HTMLDivElement | null = null // brief bright bloom at the swap midpoint

  // State.
  let inCosmic = false // which world we are in
  let blend = 0 // 0 = home look, 1 = full cosmic look (smoothed)
  let fade = 0 // 0 = clear overlay, 1 = opaque (peaks mid-transition)
  let flashAmt = 0 // 0..1 white bloom, fired once at the midpoint
  let transitioning = false
  let fadeDir = 1 // +1 fading out (to black), then -1 fading back in
  let pendingWorld = false // the world we will be in after the fade midpoint
  let swapped = false // guard so we only swap once per transition

  // Discovered existing lights (driven, never added — mirrors Sky.ts policy).
  let dirLight: THREE.DirectionalLight | null = null
  let hemiLight: THREE.HemisphereLight | null = null
  let ambLight: THREE.AmbientLight | null = null
  // Captured "home" light state so we can blend back to it.
  let homeDirInt = 2.4
  let homeHemiInt = 0.6
  let homeAmbInt = 0.25
  const _homeDirCol = new THREE.Color(1, 1, 1)
  const _homeHemiCol = new THREE.Color(1, 1, 1)
  const _homeFog = new THREE.Color()

  // ---- builders ------------------------------------------------------------

  function buildDiscMaterial(tint: THREE.Color): THREE.ShaderMaterial {
    // Additive vortex that fills the doorway: a deep swirling well, a bright
    // event-horizon rim, drifting chromatic energy and a soft inner glow. All
    // animation lives in the shader (zero CPU). uCharge brightens it on approach.
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uTint: { value: tint.clone() },
        uTint2: { value: PAL.gem.clone() },
        uTint3: { value: PAL.planeWing.clone() },
        uCharge: { value: 0 },
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
        uniform float uTime;
        uniform float uCharge;
        uniform vec3 uTint;
        uniform vec3 uTint2;
        uniform vec3 uTint3;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;            // -1..1 across the disc
          float r = length(p);
          if (r > 1.0) discard;                // round mask
          float a = atan(p.y, p.x);

          // a deep swirling well: warp the angle by radius so it spirals inward
          float spin = uTime * (1.6 + uCharge * 1.4);
          float spiral = sin(a * 3.0 + r * 9.0 - spin * 2.0) * 0.5 + 0.5;
          // concentric energy bands rushing toward the centre
          float bands = sin(r * 22.0 - uTime * (3.2 + uCharge * 2.5)) * 0.5 + 0.5;
          // fine chromatic shimmer that drifts across the disc
          float shimmer = sin((p.x + p.y) * 16.0 + uTime * 4.0) * 0.5 + 0.5;

          // bright event-horizon rim near r~0.86, soft inner glow toward centre
          float rim = smoothstep(0.78, 0.90, r) * (1.0 - smoothstep(0.90, 1.0, r));
          float core = pow(1.0 - r, 1.7);

          // colour: spiral mixes the two tints, the rim adds a warm chromatic kiss
          vec3 col = mix(uTint, uTint2, spiral);
          col = mix(col, uTint3, rim * 0.6);
          col += core * uTint2 * 0.5;

          float energy = (0.30 + 0.70 * bands) * (0.55 + 0.45 * spiral);
          float alpha = core * energy + rim * (0.7 + 0.5 * shimmer);
          alpha *= (0.62 + 0.55 * uCharge);    // charges up as you approach
          gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        }
      `,
    })
  }

  function buildPortal(ctx: GameContext, dir: THREE.Vector3, tint: THREE.Color): Portal {
    const group = new THREE.Group()

    // Surface frame: surfNormal points away from planet centre (local "up" of the
    // ground patch); the doorway FACES along a surface tangent so you fly through.
    const surfNormal = dir.clone().normalize()
    makeTangents(surfNormal, _v0, _v1) // _v0,_v1 are two ground tangents
    const facing = _v0.clone().normalize() // doorway normal (what "through" means)

    // Ring: a low-poly torus. Default torus lies in its local XY plane with axis
    // +Z. We want the axis (=doorway normal) along `facing` and the ring upright,
    // so build a basis (right, up, forward=axis) and set the quaternion.
    const ringUp = surfNormal // ring's local up = ground normal (stands upright)
    const ringRight = _v2.clone().crossVectors(ringUp, facing).normalize()
    const ringFwd = _toPlayer.clone().crossVectors(ringRight, ringUp).normalize()
    const basis = new THREE.Matrix4().makeBasis(ringRight, ringUp, ringFwd)
    const ringQuat = new THREE.Quaternion().setFromRotationMatrix(basis)

    const ringGeo = new THREE.TorusGeometry(RING_INNER, RING_TUBE, 10, 32)
    const ringMat = new THREE.MeshStandardMaterial({
      color: tint.clone(),
      emissive: tint.clone().multiplyScalar(0.6),
      emissiveIntensity: 1.4,
      flatShading: true,
      roughness: 0.5,
      metalness: 0.1,
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.quaternion.copy(ringQuat)
    ring.frustumCulled = true
    group.add(ring)

    // Shimmer vortex disc fills the doorway (the round shader masks it).
    const discGeo = new THREE.PlaneGeometry(RING_INNER * 2, RING_INNER * 2)
    const discMat = buildDiscMaterial(tint)
    const disc = new THREE.Mesh(discGeo, discMat)
    disc.quaternion.copy(ringQuat) // plane lies in ring's local XY (normal = axis)
    disc.frustumCulled = true
    disc.renderOrder = 1
    group.add(disc)

    // Orbiting energy motes around the doorway — ONE InstancedMesh, animated in
    // update() with zero allocation. They sit in the doorway plane (right/up).
    const moteGeo = new THREE.TetrahedronGeometry(0.34, 0)
    const moteMat = new THREE.MeshStandardMaterial({
      color: PAL.gem.clone(),
      emissive: PAL.gem.clone().multiplyScalar(0.9),
      emissiveIntensity: 1.6,
      flatShading: true,
      roughness: 0.35,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
    })
    const motes = new THREE.InstancedMesh(moteGeo, moteMat, MOTE_COUNT)
    motes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    motes.frustumCulled = false
    motes.renderOrder = 2
    group.add(motes)

    // Soft attract halo behind the doorway — swells as you approach (charge).
    const haloMat = new THREE.SpriteMaterial({
      map: sharedRadialTex,
      color: tint.clone().lerp(PAL.planeWing, 0.25),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    })
    const halo = new THREE.Sprite(haloMat)
    halo.scale.setScalar(RING_INNER * 4.2)
    halo.frustumCulled = true
    halo.renderOrder = 0
    group.add(halo)

    // A couple of low-poly gem studs at the base for charm.
    const studGeo = new THREE.OctahedronGeometry(0.8, 0)
    const studMat = new THREE.MeshStandardMaterial({
      color: PAL.gem.clone(),
      emissive: PAL.gem.clone().multiplyScalar(0.3),
      flatShading: true,
      roughness: 0.4,
    })
    for (let s = 0; s < 2; s++) {
      const stud = new THREE.Mesh(studGeo, studMat)
      const side = s === 0 ? 1 : -1
      stud.position.copy(ringRight).multiplyScalar(side * (RING_INNER + 0.6))
      stud.frustumCulled = true
      group.add(stud)
    }

    // Place the whole group on the surface; centre lifted so the hole clears ground.
    const center = ctx.planet.surfacePoint(surfNormal, RING_ALT)
    group.position.copy(center)
    group.frustumCulled = false

    return {
      group,
      ringMat,
      discMat,
      motes,
      haloMat,
      right: ringRight.clone(),
      upAxis: ringUp.clone(),
      center: center.clone(),
      normal: facing.clone(),
      prevSide: 0,
      primed: false,
      charge: 0,
    }
  }

  function buildCosmicMood(ctx: GameContext): void {
    cosmic = new THREE.Group()
    cosmic.name = 'cosmicMood'
    cosmic.visible = false

    // --- Cosmic dome ----------------------------------------------------------
    // Drawn IN FRONT of the normal sky dome (renderOrder ordering, depthTest off)
    // so it fully occludes the cozy gradient without touching Sky.ts. Its opacity
    // is the blend amount, so it cross-fades the home sky in/out.
    domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      transparent: true,
      fog: false,
      toneMapped: false,
      uniforms: {
        uTop: { value: _cosTopBase.clone() },
        uHorizon: { value: _cosHorBase.clone() },
        uNebula: { value: PAL.gem.clone().lerp(new THREE.Color(0x4a1d7a), 0.6) },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uCenter: { value: new THREE.Vector3(0, 0, 0) },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform vec3 uNebula;
        uniform vec3 uUp;
        uniform vec3 uCenter;
        uniform float uOpacity;
        uniform float uTime;
        varying vec3 vWorld;
        // cheap hash + value noise for a soft nebula band baked into the dome
        float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          float a = hash(i), b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }
        void main() {
          vec3 dir = normalize(vWorld - uCenter);
          float h = clamp(dot(dir, uUp) * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(uHorizon, uTop, pow(h, 0.7));
          // a soft drifting nebula band, strongest around the mid sky
          float n = vnoise(dir.xz * 3.0 + uTime * 0.02) * 0.6
                  + vnoise(dir.xz * 7.0 - uTime * 0.015) * 0.4;
          float band = smoothstep(0.25, 0.85, n) * (1.0 - abs(h - 0.55) * 1.6);
          col += uNebula * clamp(band, 0.0, 1.0) * 0.45;
          // sparse twinkling star dust in the upper sky
          vec2 cell = floor(dir.xz * 60.0 + dir.y * 30.0);
          float s = hash(cell);
          float star = step(0.992, s) * (0.6 + 0.4 * sin(uTime * 3.0 + s * 30.0));
          col += star * h;
          gl_FragColor = vec4(col, uOpacity);
        }
      `,
    })
    const domeGeo = new THREE.IcosahedronGeometry(DOME_RADIUS, 2)
    dome = new THREE.Mesh(domeGeo, domeMat)
    dome.frustumCulled = false
    dome.renderOrder = -8 // after Sky's dome(-10)/sun(-9), still behind scene
    dome.matrixAutoUpdate = false
    cosmic.add(dome)

    // --- Starfield (one additive Points draw call) ----------------------------
    const starGeo = new THREE.BufferGeometry()
    const pos = new Float32Array(STAR_COUNT * 3)
    const col = new Float32Array(STAR_COUNT * 3)
    const shell = DOME_RADIUS * 0.78
    const cWarm = PAL.sun.clone()
    const cCool = PAL.gem.clone()
    for (let i = 0; i < STAR_COUNT; i++) {
      // uniform-ish on a sphere
      const z = ctx.rand() * 2 - 1
      const a = ctx.rand() * TWO_PI
      const r = Math.sqrt(Math.max(0, 1 - z * z))
      const x = Math.cos(a) * r
      const y = z
      const w = Math.sin(a) * r
      // jitter the shell radius a touch so stars feel volumetric, not on a sphere
      const rr = shell * (0.86 + ctx.rand() * 0.18)
      pos[i * 3] = x * rr
      pos[i * 3 + 1] = y * rr
      pos[i * 3 + 2] = w * rr
      const tt = ctx.rand()
      const cr = cWarm.r + (cCool.r - cWarm.r) * tt
      const cg = cWarm.g + (cCool.g - cWarm.g) * tt
      const cb = cWarm.b + (cCool.b - cWarm.b) * tt
      // power-law brightness → a few bright stars, many faint ones
      const bright = 0.35 + Math.pow(ctx.rand(), 2.2) * 0.85
      col[i * 3] = cr * bright
      col[i * 3 + 1] = cg * bright
      col[i * 3 + 2] = cb * bright
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    starGeo.computeBoundingSphere()
    starMat = new THREE.PointsMaterial({
      size: 6,
      sizeAttenuation: true,
      map: sharedRadialTex,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    })
    stars = new THREE.Points(starGeo, starMat)
    stars.frustumCulled = false
    stars.renderOrder = -7 // in front of dome, behind scene/portals
    cosmic.add(stars)

    // --- Nebula sprites (depth + colour pop) ----------------------------------
    // A few soft clouds in varied indigo/teal tints, parked on the dome shell.
    const nebTints = [
      PAL.gem.clone().lerp(PAL.planeWing, 0.2),
      _cosHorBase.clone().lerp(PAL.gem, 0.4),
      PAL.gem.clone().lerp(new THREE.Color(0x6a2db0), 0.55),
    ]
    for (let i = 0; i < nebTints.length; i++) {
      const nebMat = new THREE.SpriteMaterial({
        map: sharedRadialTex,
        color: nebTints[i],
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        fog: false,
        toneMapped: false,
      })
      nebulaMats.push(nebMat)
      const spr = new THREE.Sprite(nebMat)
      const d = _v0.set(ctx.rand() * 2 - 1, ctx.rand() * 1.2 + 0.1, ctx.rand() * 2 - 1).normalize()
      spr.position.copy(d).multiplyScalar(DOME_RADIUS * 0.7)
      spr.scale.setScalar(420 + ctx.rand() * 280)
      spr.renderOrder = -7
      spr.frustumCulled = false
      nebulae.push(spr)
      cosmic.add(spr)
    }

    ctx.scene.add(cosmic)
  }

  function buildOverlay(ctx: GameContext): void {
    overlay = document.createElement('div')
    overlay.style.cssText =
      'position:absolute;inset:0;pointer-events:none;opacity:0;' +
      'background:radial-gradient(circle at 50% 50%,#2a0d5e 0%,#120833 45%,#05030f 100%);' +
      'transition:none;z-index:50;will-change:opacity;'
    ctx.hud.root.appendChild(overlay)

    // A brief warm bloom fired exactly at the swap midpoint for a "pop".
    flash = document.createElement('div')
    flash.style.cssText =
      'position:absolute;inset:0;pointer-events:none;opacity:0;' +
      'background:radial-gradient(circle at 50% 50%,#fff6e0 0%,rgba(127,239,255,0.35) 35%,rgba(0,0,0,0) 70%);' +
      'transition:none;z-index:51;will-change:opacity;mix-blend-mode:screen;'
    ctx.hud.root.appendChild(flash)
  }

  // ---- transition ----------------------------------------------------------

  function beginTransition(toCosmic: boolean, ctx: GameContext): void {
    if (transitioning) return
    transitioning = true
    fadeDir = 1 // fade to black first
    pendingWorld = toCosmic
    swapped = false
    // Keep the cosmic layer present during the whole fade so the swap at the
    // midpoint is seamless (we only flip `inCosmic` at the midpoint).
    cosmic.visible = true
    ctx.audio.play('portal', { volume: 0.95 })
    ctx.events.emit('boost', { from: 'portal' }) // nudge any camera/fov juice
  }

  // ---- lifecycle -----------------------------------------------------------

  return {
    name: 'portals',

    init(ctx: GameContext): void {
      portalGroup = new THREE.Group()
      portalGroup.name = 'portals'

      sharedRadialTex = makeRadialTexture() // one upload, shared by all sprites/stars

      // Home portal: ahead-ish of the spawn (player spawns near +Y top). Pick
      // stable-but-seeded directions so they are discoverable but not on top of you.
      const homeDir = _v0.set(0.55, 0.62, 0.55).normalize().clone()
      const cosmicDir = _v1.set(-0.6, 0.4, 0.6).normalize().clone()

      const homePortal = buildPortal(ctx, homeDir, PAL.gem.clone().lerp(PAL.planeWing, 0.25))
      const returnPortal = buildPortal(ctx, cosmicDir, PAL.planeBody.clone().lerp(PAL.gem, 0.5))
      portals = [homePortal, returnPortal]
      portalGroup.add(homePortal.group)
      portalGroup.add(returnPortal.group)
      ctx.scene.add(portalGroup)

      buildCosmicMood(ctx)
      buildOverlay(ctx)

      // Register portal locations as landmarks so other systems (e.g. nav) can use them.
      const lm = (ctx as any).landmarks as THREE.Vector3[] | undefined
      if (Array.isArray(lm)) {
        lm.push(homePortal.center.clone())
        lm.push(returnPortal.center.clone())
      }

      // Discover existing lights to drive (add none — same policy as Sky).
      ctx.scene.traverse((o) => {
        if (!dirLight && (o as THREE.DirectionalLight).isDirectionalLight) {
          dirLight = o as THREE.DirectionalLight
        } else if (!hemiLight && (o as THREE.HemisphereLight).isHemisphereLight) {
          hemiLight = o as THREE.HemisphereLight
        } else if (!ambLight && (o as THREE.AmbientLight).isAmbientLight) {
          ambLight = o as THREE.AmbientLight
        }
      })
      if (dirLight) {
        homeDirInt = dirLight.intensity
        _homeDirCol.copy(dirLight.color)
      }
      if (hemiLight) {
        homeHemiInt = hemiLight.intensity
        _homeHemiCol.copy(hemiLight.color)
      }
      if (ambLight) homeAmbInt = ambLight.intensity
      if (ctx.scene.fog) _homeFog.copy((ctx.scene.fog as THREE.Fog).color)
      else _homeFog.copy(PAL.skyHorizon)
    },

    update(dt: number, ctx: GameContext): void {
      const t = ctx.elapsed()

      ctx.player.obj.getWorldPosition(_playerPos)

      // --- per-portal: shimmer, charge, motes, halo ---------------------------
      for (let i = 0; i < portals.length; i++) {
        const p = portals[i]

        // proximity → charge target (only the armed portal lights up fully)
        _toPlayer.copy(_playerPos).sub(p.center)
        const dist2 = _toPlayer.lengthSq()
        const armed = inCosmic ? i === 1 : i === 0
        let chargeTarget = 0
        if (armed && dist2 < ARM_RANGE2) {
          chargeTarget = 1 - Math.sqrt(dist2) / ARM_RANGE // 1 at centre → 0 at edge
        }
        p.charge += (chargeTarget - p.charge) * damp(3.0, dt)

        // disc shader: drive time + charge
        p.discMat.uniforms.uTime.value = t
        p.discMat.uniforms.uCharge.value = p.charge

        // ring pulse — faster & brighter as it charges (alive + inviting)
        const pulse = 1.1 + Math.sin(t * (2.0 + p.charge * 3.0)) * (0.3 + p.charge * 0.5)
        p.ringMat.emissiveIntensity = pulse + p.charge * 0.6

        // attract halo swells with charge, with a gentle breathing wobble
        const halo = p.haloMat
        halo.opacity = (0.12 + 0.55 * p.charge) * (0.85 + 0.15 * Math.sin(t * 4.0))

        // orbiting motes — ONE InstancedMesh, zero allocation
        const motes = p.motes
        const orbitR = RING_INNER + 0.4 + Math.sin(t * 1.5) * 0.25
        const baseSpin = t * (0.9 + p.charge * 1.6)
        for (let m = 0; m < MOTE_COUNT; m++) {
          const ang = baseSpin + (m / MOTE_COUNT) * TWO_PI
          const ca = Math.cos(ang)
          const sa = Math.sin(ang)
          // position in the doorway plane (right & upAxis), relative to group origin
          _motePos
            .copy(p.right)
            .multiplyScalar(ca * orbitR)
            .addScaledVector(p.upAxis, sa * orbitR)
          // small in/out bob along the doorway normal so they weave through the ring
          _motePos.addScaledVector(p.normal, Math.sin(ang * 2.0 + t * 2.2) * 0.6)
          const sc = 0.6 + 0.5 * (0.5 + 0.5 * Math.sin(t * 3.0 + m))
          _moteScale.setScalar(sc * (0.8 + p.charge * 0.6))
          _moteQuat.setFromAxisAngle(p.normal, ang * 1.7)
          _moteMat.compose(_motePos, _moteQuat, _moteScale)
          motes.setMatrixAt(m, _moteMat)
          // tint motes between gem and warm wing by index for variety
          _colTmp.copy(PAL.gem).lerp(PAL.planeWing, (m % 3) / 2)
          motes.setColorAt(m, _colTmp)
        }
        motes.instanceMatrix.needsUpdate = true
        if (motes.instanceColor) motes.instanceColor.needsUpdate = true
        motes.visible = p.charge > 0.02 || armed
      }

      // --- crossing detection -------------------------------------------------
      if (!transitioning) {
        for (let i = 0; i < portals.length; i++) {
          const p = portals[i]
          _toPlayer.copy(_playerPos).sub(p.center)
          const dist2 = _toPlayer.lengthSq()
          const armed = inCosmic ? i === 1 : i === 0
          // signed distance to the doorway plane (normal · (player - center))
          const side = _toPlayer.dot(p.normal)
          // radial distance within the doorway disc (project out the normal comp)
          _v2.copy(_toPlayer).addScaledVector(p.normal, -side)
          const inHole = _v2.lengthSq() <= PASS_RADIUS * PASS_RADIUS
          const near = dist2 < ARM_RANGE2 // within arming range → consider crossing

          if (near && !p.primed) {
            p.primed = true
            p.prevSide = side >= 0 ? 1 : -1
          }
          if (!near) {
            p.primed = false
            p.prevSide = 0
            continue
          }

          const curSign = side >= 0 ? 1 : -1
          if (armed && p.primed && inHole && p.prevSide !== 0 && curSign !== p.prevSide) {
            // crossed the doorway plane while inside the ring → travel!
            beginTransition(!inCosmic, ctx)
          }
          p.prevSide = curSign
        }
      }

      // --- transition fade machine -------------------------------------------
      if (transitioning) {
        fade += fadeDir * (dt / FADE_SECONDS)
        if (fadeDir > 0 && fade >= 1) {
          // midpoint: swap the world now (screen is opaque), then fade back in.
          fade = 1
          fadeDir = -1
          if (!swapped) {
            swapped = true
            inCosmic = pendingWorld
            flashAmt = 1 // pop the bloom at the seam
            ctx.events.emit('enterWorld', { id: inCosmic ? 'cosmic' : 'home' })
            ctx.hud.toast(
              inCosmic ? 'Entered the Cosmic Drift' : 'Back to the cozy skies',
              2200
            )
            // reset portal priming so we do not immediately re-trigger on the far side
            for (let i = 0; i < portals.length; i++) {
              portals[i].primed = false
              portals[i].prevSide = 0
            }
          }
        } else if (fadeDir < 0 && fade <= 0) {
          fade = 0
          transitioning = false
        }
      }
      // overlay fade with a soft ease so the wash feels velvety, not linear
      if (overlay) {
        const eased = fade * fade * (3 - 2 * fade) // smoothstep
        overlay.style.opacity = eased.toFixed(3)
      }
      // bloom decays quickly after the seam
      if (flashAmt > 0) {
        flashAmt = Math.max(0, flashAmt - dt * 2.2)
        if (flash) flash.style.opacity = flashAmt.toFixed(3)
      }

      // --- blend toward the target world look (smoothed, dt-invariant) --------
      const target = inCosmic ? 1 : 0
      blend += (target - blend) * damp(2.4, dt)
      const b = blend

      // Cosmic layer only needs to render while there is any blend or a fade.
      const showCosmic = b > 0.002 || transitioning
      cosmic.visible = showCosmic

      if (showCosmic) {
        // recentre dome on camera so it is effectively at infinity (never culls)
        ctx.camera.getWorldPosition(_camWorld)
        _domeUp.copy(_camWorld).sub(ctx.planet.mesh.position).normalize()
        if (!isFinite(_domeUp.x) || _domeUp.lengthSq() < 1e-6) _domeUp.set(0, 1, 0)
        dome.position.copy(_camWorld)
        dome.updateMatrix()
        const du = domeMat.uniforms
        ;(du.uUp.value as THREE.Vector3).copy(_domeUp)
        ;(du.uCenter.value as THREE.Vector3).copy(ctx.planet.mesh.position)
        du.uOpacity.value = b
        du.uTime.value = t

        // starfield follows the camera (parked at infinity); slow drift + fade.
        stars.position.copy(_camWorld)
        stars.rotation.y = t * 0.01 // gentle galactic drift
        // twinkle: subtle global size breathe (cheap, no per-point work)
        starMat.size = 6 + Math.sin(t * 1.3) * 0.8
        starMat.opacity = b

        // nebula clouds breathe slowly at different phases for a living sky
        for (let i = 0; i < nebulaMats.length; i++) {
          nebulaMats[i].opacity = (0.32 + 0.16 * Math.sin(t * 0.3 + i * 1.7)) * b
        }
      }

      // --- tint fog + clear colour toward cosmic (best-effort each frame) -----
      // Sky.ts may also write these; by blending toward a mix every frame we stay
      // correct whether we run before or after it (it converges to our value when
      // fully cosmic, and yields back to home values as blend → 0).
      if (b > 0.002) {
        const fog = ctx.scene.fog as THREE.Fog | null
        if (fog && (fog as any).isFog) {
          _fogA.copy(_homeFog).lerp(_cosFog, b)
          fog.color.copy(_fogA)
          ctx.renderer.setClearColor(fog.color, 1)
        }
      }

      // --- drive existing lights toward a cool, dim cosmic mood ---------------
      if (dirLight) {
        const targetInt = homeDirInt * (1 - 0.62 * b)
        dirLight.intensity += (targetInt - dirLight.intensity) * damp(2.5, dt)
        dirLight.color.setRGB(
          _homeDirCol.r + (PAL.gem.r - _homeDirCol.r) * b,
          _homeDirCol.g + (PAL.gem.g - _homeDirCol.g) * b,
          _homeDirCol.b + (PAL.gem.b - _homeDirCol.b) * b
        )
      }
      if (hemiLight) {
        const targetInt = homeHemiInt * (1 - 0.5 * b)
        hemiLight.intensity += (targetInt - hemiLight.intensity) * damp(2.5, dt)
        hemiLight.color.setRGB(
          _homeHemiCol.r + (_cosTopBase.r - _homeHemiCol.r) * b,
          _homeHemiCol.g + (_cosTopBase.g - _homeHemiCol.g) * b,
          _homeHemiCol.b + (_cosTopBase.b - _homeHemiCol.b) * b
        )
      }
      if (ambLight) {
        const targetInt = homeAmbInt * (1 + 0.6 * b) // lift ambient a touch in the dark
        ambLight.intensity += (targetInt - ambLight.intensity) * damp(2.5, dt)
      }
    },

    dispose(): void {
      // portals
      for (let i = 0; i < portals.length; i++) {
        const p = portals[i]
        p.group.traverse((o) => {
          const mesh = o as THREE.Mesh
          const g = (mesh as any).geometry as THREE.BufferGeometry | undefined
          if (g && typeof g.dispose === 'function') g.dispose()
          const mat = (mesh as any).material as THREE.Material | THREE.Material[] | undefined
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
          else if (mat) mat.dispose()
        })
      }
      portalGroup?.parent?.remove(portalGroup)

      // cosmic mood
      if (cosmic) {
        cosmic.traverse((o) => {
          const mesh = o as THREE.Mesh
          const g = (mesh as any).geometry as THREE.BufferGeometry | undefined
          if (g && typeof g.dispose === 'function') g.dispose()
        })
        domeMat?.dispose()
        starMat?.dispose()
        for (let i = 0; i < nebulaMats.length; i++) nebulaMats[i].dispose()
        cosmic.parent?.remove(cosmic)
      }

      // shared texture (used by halos/nebulae/stars) — dispose once, last.
      if (sharedRadialTex) sharedRadialTex.dispose()

      overlay?.parentElement?.removeChild(overlay)
      flash?.parentElement?.removeChild(flash)
      overlay = null
      flash = null
      portals = []
      nebulae = []
      nebulaMats = []
    },
  }
}
