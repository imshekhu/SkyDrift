import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { TUNING, damp } from '../plane/flight'
import { PAL } from '../art/palette'

/**
 * Trails.ts — player motion FX bolted to the plane's world transform.
 *
 * FOUR layers, all additive + un-toneMapped so they read as soft light, all
 * pooled with ZERO per-frame allocation in update():
 *
 *  1. WINGTIP VAPOR RIBBONS — two long, softly-fading ribbons streaming from
 *     the wingtip anchors (local +/-X). Each ribbon is a pre-allocated quad
 *     strip whose centerline lives in a RING BUFFER: every frame we stamp the
 *     two live wingtip world-points into the head slot and advance a cursor.
 *     Nothing is created per frame — we rewrite a handful of floats and flag the
 *     attributes dirty. Opacity tapers head→tail (by index AND by age) so the
 *     ribbon dissolves behind the plane, and the head fades IN so new vapor
 *     blooms rather than popping. Width tapers along the length for a wisp.
 *
 *  2. ENGINE EXHAUST — a small additive Points pool spawned just behind the
 *     tail (local -Z). Spawn RATE scales with speed/boost; puffs drift, swell,
 *     cool from warm gold → pale vapor over a short life (per-vertex color),
 *     and buoyantly rise a touch. Pooled in flat arrays, recycled in a ring.
 *
 *  3. CONTRAILS — not a 4th object: at high speed (boost / above cruise) we
 *     fatten + brighten the ribbons and push the exhaust harder so the wing
 *     streaks visually "snap" into crisp contrails. One smoothed scalar
 *     (`fast`) drives all of it, plus a faint shimmer at top speed.
 *
 *  4. BOOST FLAME — a dedicated, tight afterburner jet directly behind the tail
 *     that only ignites with `fast`. Hot coral→gold core particles fire backward
 *     fast on a very short life, so the plane gets a visible thrust plume the
 *     instant boost engages. Separate pool, capped, recycled.
 *
 * Reads the shared boost flag at (ctx as any).boostActive when present
 * (published by Boost.ts), else falls back to player.boosting. Honors an
 * optional (ctx as any).fxQuality in [0..1] to thin particles on weak devices.
 *
 * Mobile-perf: 2 draw calls for ribbons + 1 exhaust + 1 flame = 4 total, fixed
 * buffers, DynamicDrawUsage, frustumCulled off (FX hug the camera), ZERO
 * per-frame allocation in update().
 */
export function createTrailsSystem(): GameSystem {
  // ----------------------------- tuning -----------------------------
  const RIBBON_SEGMENTS = 72 // ring-buffer length per wingtip ribbon (longer history → longer trail)
  const RIBBON_HALF_W = 0.5 // half-width of the ribbon quad at the head (world units)
  const WINGTIP_X = 2.6 // |local X| of each wingtip anchor
  const WINGTIP_Y = 0.05 // slight lift so the ribbon clears the wing
  const WINGTIP_Z = -0.4 // a touch behind the wing's mid-chord
  const EMIT_MIN_SPEED = 6 // below this the ribbon stops laying new vapor (parked)
  const STAMP_DISTANCE = 0.85 // min world-distance the plane must travel to drop a new node
  const RIBBON_FADE_SECONDS = 2.1 // how long a node takes to age out (longer = lingering vapor)

  const EXHAUST_COUNT = 110 // capped particle budget (mobile-friendly)
  const EXHAUST_Z = -3.1 // tail emitter offset (local -Z = behind nose)
  const EXHAUST_LIFE = 0.62 // seconds a puff lives
  const EXHAUST_SIZE = 1.5 // base point size (px-ish, attenuated)
  const EXHAUST_DRIFT = 3.0 // backward drift speed relative to plane (world units/s)
  const EXHAUST_SPREAD = 0.34 // lateral jitter radius at spawn
  const EXHAUST_RISE = 0.9 // gentle buoyant lift (world up) over life
  const BASE_RATE = 28 // puffs/sec at cruise
  const BOOST_RATE = 130 // puffs/sec at full boost

  const FLAME_COUNT = 64 // afterburner core budget
  const FLAME_Z = -3.0 // jet origin (just behind the tail, tighter than exhaust)
  const FLAME_LIFE = 0.3 // very short life → tight, snappy plume
  const FLAME_SIZE = 2.2 // bigger, hotter cores
  const FLAME_SPEED = 14 // backward jet speed (fast → reads as thrust)
  const FLAME_SPREAD = 0.16 // tight nozzle
  const FLAME_RATE = 150 // cores/sec at full boost (scaled by `fast`)

  // ----------------------------- state -----------------------------
  // `fast` ∈ [0..1]: 0 = cruise, 1 = full boost — drives contrail intensity.
  let fast = 0
  let inited = false

  // Per-ribbon ring buffers. We keep the *centerline* node history (one world
  // point per tip + one ribbon "side" axis per node) so we can rebuild quads.
  // Both ribbons share the same cursor (they're stamped together).
  let head = 0 // index of the most-recently-written node
  let filled = 0 // how many nodes are valid (ramps up to RIBBON_SEGMENTS)
  const nodeLX = new Float32Array(RIBBON_SEGMENTS)
  const nodeLY = new Float32Array(RIBBON_SEGMENTS)
  const nodeLZ = new Float32Array(RIBBON_SEGMENTS)
  const nodeRX = new Float32Array(RIBBON_SEGMENTS)
  const nodeRY = new Float32Array(RIBBON_SEGMENTS)
  const nodeRZ = new Float32Array(RIBBON_SEGMENTS)
  // ribbon "side" axis per node (plane's world +Y at stamp time → ribbon faces flat)
  const sideX = new Float32Array(RIBBON_SEGMENTS)
  const sideY = new Float32Array(RIBBON_SEGMENTS)
  const sideZ = new Float32Array(RIBBON_SEGMENTS)
  // age (seconds) of each node so tails fade with time, not just position
  const nodeAge = new Float32Array(RIBBON_SEGMENTS)

  let lastStampX = 0
  let lastStampY = 0
  let lastStampZ = 0
  let haveLastStamp = false

  let ribbonL: THREE.Mesh | null = null
  let ribbonR: THREE.Mesh | null = null
  let ribbonGeoL: THREE.BufferGeometry | null = null
  let ribbonGeoR: THREE.BufferGeometry | null = null
  let ribbonMat: THREE.MeshBasicMaterial | null = null
  // CPU-side vertex arrays (2 verts per node → a strip). Uploaded each frame.
  let posL: Float32Array | null = null
  let posR: Float32Array | null = null
  let alphaL: Float32Array | null = null
  let alphaR: Float32Array | null = null
  let posAttrL: THREE.BufferAttribute | null = null
  let posAttrR: THREE.BufferAttribute | null = null
  let alphaAttrL: THREE.BufferAttribute | null = null
  let alphaAttrR: THREE.BufferAttribute | null = null

  // ----- exhaust particle pool -----
  let exhaust: THREE.Points | null = null
  let exhaustGeo: THREE.BufferGeometry | null = null
  let exhaustMat: THREE.PointsMaterial | null = null
  let exPos: Float32Array | null = null
  let exAlpha: Float32Array | null = null
  let exCol: Float32Array | null = null // per-vertex RGB (warm → cool over life)
  let exPosAttr: THREE.BufferAttribute | null = null
  let exAlphaAttr: THREE.BufferAttribute | null = null
  let exColAttr: THREE.BufferAttribute | null = null
  const exVX = new Float32Array(EXHAUST_COUNT)
  const exVY = new Float32Array(EXHAUST_COUNT)
  const exVZ = new Float32Array(EXHAUST_COUNT)
  const exLife = new Float32Array(EXHAUST_COUNT) // remaining life; <=0 means dead
  const exMax = new Float32Array(EXHAUST_COUNT) // per-particle total life (for normalized fade)
  const exSeed = new Float32Array(EXHAUST_COUNT) // per-particle phase for turbulence/size variety
  let exCursor = 0
  let emitAccum = 0 // fractional puff accumulator

  // ----- boost flame (afterburner) pool -----
  let flame: THREE.Points | null = null
  let flameGeo: THREE.BufferGeometry | null = null
  let flameMat: THREE.PointsMaterial | null = null
  let flPos: Float32Array | null = null
  let flAlpha: Float32Array | null = null
  let flCol: Float32Array | null = null
  let flPosAttr: THREE.BufferAttribute | null = null
  let flAlphaAttr: THREE.BufferAttribute | null = null
  let flColAttr: THREE.BufferAttribute | null = null
  const flVX = new Float32Array(FLAME_COUNT)
  const flVY = new Float32Array(FLAME_COUNT)
  const flVZ = new Float32Array(FLAME_COUNT)
  const flLife = new Float32Array(FLAME_COUNT)
  let flCursor = 0
  let flameAccum = 0

  // --------------------- module-scoped temps (no per-frame alloc) ---------------------
  const _q = new THREE.Quaternion()
  const _pos = new THREE.Vector3()
  const _up = new THREE.Vector3()
  const _back = new THREE.Vector3()
  const _tipL = new THREE.Vector3()
  const _tipR = new THREE.Vector3()
  const _emit = new THREE.Vector3()

  // cached FX colors (built once at init from PAL — never reallocated per frame)
  const _cHot = new THREE.Color() // hot afterburner core (warm coral, slightly hotter than body)
  const _cGold = new THREE.Color() // mid exhaust (warm gold wing tone)
  const _cVapor = new THREE.Color() // cooled exhaust tail (pale sky vapor)

  // map a ring index k (0 = newest .. n-1 = oldest) → absolute buffer slot
  function slotOf(k: number): number {
    let s = head - k
    while (s < 0) s += RIBBON_SEGMENTS
    return s
  }

  function quality(ctx: GameContext): number {
    const q = (ctx as any).fxQuality
    return typeof q === 'number' ? THREE.MathUtils.clamp(q, 0.3, 1) : 1
  }

  function boostFlag(ctx: GameContext): boolean {
    const b = (ctx as any).boostActive
    if (typeof b === 'boolean') return b
    return ctx.player.boosting
  }

  // Reset all ribbon nodes to a single world point (used on first frame / re-seed).
  function seedRibbon(lx: number, ly: number, lz: number, rx: number, ry: number, rz: number, ux: number, uy: number, uz: number) {
    for (let i = 0; i < RIBBON_SEGMENTS; i++) {
      nodeLX[i] = lx; nodeLY[i] = ly; nodeLZ[i] = lz
      nodeRX[i] = rx; nodeRY[i] = ry; nodeRZ[i] = rz
      sideX[i] = ux; sideY[i] = uy; sideZ[i] = uz
      nodeAge[i] = 999 // old → invisible until overwritten
    }
    head = 0
    filled = 1
    nodeAge[0] = 0
  }

  // Write a fresh node pair at the head (advance cursor first).
  function stampNode(lx: number, ly: number, lz: number, rx: number, ry: number, rz: number, ux: number, uy: number, uz: number) {
    head = (head + 1) % RIBBON_SEGMENTS
    nodeLX[head] = lx; nodeLY[head] = ly; nodeLZ[head] = lz
    nodeRX[head] = rx; nodeRY[head] = ry; nodeRZ[head] = rz
    sideX[head] = ux; sideY[head] = uy; sideZ[head] = uz
    nodeAge[head] = 0
    if (filled < RIBBON_SEGMENTS) filled++
  }

  // Shared onBeforeCompile patch: vertex-alpha fade + (optional) vertex color +
  // soft round point disc. Reused so all additive FX share the same look.
  const patchPoints = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.vertexShader =
      'attribute float aAlpha;\nvarying float vAlpha;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vAlpha = aAlpha;'
      )
    shader.fragmentShader =
      'varying float vAlpha;\n' +
      shader.fragmentShader
        .replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\n  gl_FragColor.a *= vAlpha;'
        )
        // round the square point into a soft glowing disc with a hot center
        .replace(
          'vec4 diffuseColor = vec4( diffuse, opacity );',
          'vec2 _pc = gl_PointCoord - 0.5;\n  float _d = dot(_pc, _pc);\n  if (_d > 0.25) discard;\n  float _soft = 1.0 - smoothstep(0.0, 0.25, _d);\n  vec4 diffuseColor = vec4( diffuse, opacity * _soft );'
        )
  }

  return {
    name: 'trails',

    init(ctx: GameContext) {
      // cache FX colors once (cohesion: warm coral/gold core → pale sky vapor tail)
      _cHot.copy(PAL.planeBody).lerp(PAL.planeWing, 0.35) // hot but not neon
      _cGold.copy(PAL.planeWing)
      _cVapor.copy(PAL.skyHorizon)

      // ---------------- ribbon material (shared by both wingtips) ----------------
      // Vertex-alpha-driven fade via a tiny onBeforeCompile patch so the ribbon
      // dissolves head→tail without a custom ShaderMaterial.
      const mat = new THREE.MeshBasicMaterial({
        color: PAL.skyHorizon, // soft pastel white-blue vapor (cozy, not neon)
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        toneMapped: false,
        side: THREE.DoubleSide,
        fog: false,
      })
      mat.onBeforeCompile = (shader) => {
        shader.vertexShader =
          'attribute float aAlpha;\nvarying float vAlpha;\n' +
          shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n  vAlpha = aAlpha;'
          )
        shader.fragmentShader =
          'varying float vAlpha;\n' +
          shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            '#include <dithering_fragment>\n  gl_FragColor.a *= vAlpha;'
          )
      }
      ribbonMat = mat

      // Two verts per node → triangle-strip-style quad ribbon. We emit indices
      // once at init; positions/alpha refresh per frame.
      const vertCount = RIBBON_SEGMENTS * 2
      posL = new Float32Array(vertCount * 3)
      posR = new Float32Array(vertCount * 3)
      alphaL = new Float32Array(vertCount)
      alphaR = new Float32Array(vertCount)

      const idxCount = (RIBBON_SEGMENTS - 1) * 6
      const idx = new Uint16Array(idxCount)
      let o = 0
      for (let s = 0; s < RIBBON_SEGMENTS - 1; s++) {
        const a = s * 2 // segment s: left edge vert
        const b = s * 2 + 1 // segment s: right edge vert
        const cc = (s + 1) * 2 // next segment left
        const d = (s + 1) * 2 + 1 // next segment right
        idx[o++] = a; idx[o++] = b; idx[o++] = cc
        idx[o++] = b; idx[o++] = d; idx[o++] = cc
      }

      const buildRibbonGeo = (pos: Float32Array, alpha: Float32Array) => {
        const g = new THREE.BufferGeometry()
        const pa = new THREE.BufferAttribute(pos, 3)
        pa.setUsage(THREE.DynamicDrawUsage)
        const aa = new THREE.BufferAttribute(alpha, 1)
        aa.setUsage(THREE.DynamicDrawUsage)
        g.setAttribute('position', pa)
        g.setAttribute('aAlpha', aa)
        g.setIndex(new THREE.BufferAttribute(idx.slice(), 1))
        g.setDrawRange(0, 0) // nothing visible until we have history
        return { g, pa, aa }
      }

      const L = buildRibbonGeo(posL, alphaL)
      const R = buildRibbonGeo(posR, alphaR)
      ribbonGeoL = L.g; posAttrL = L.pa; alphaAttrL = L.aa
      ribbonGeoR = R.g; posAttrR = R.pa; alphaAttrR = R.aa

      const mL = new THREE.Mesh(L.g, mat)
      const mR = new THREE.Mesh(R.g, mat)
      mL.frustumCulled = false
      mR.frustumCulled = false
      mL.renderOrder = 998
      mR.renderOrder = 998
      ctx.scene.add(mL)
      ctx.scene.add(mR)
      ribbonL = mL
      ribbonR = mR

      // ---------------- exhaust points pool (vertex-colored) ----------------
      exPos = new Float32Array(EXHAUST_COUNT * 3)
      exAlpha = new Float32Array(EXHAUST_COUNT)
      exCol = new Float32Array(EXHAUST_COUNT * 3)
      const eg = new THREE.BufferGeometry()
      exPosAttr = new THREE.BufferAttribute(exPos, 3)
      exPosAttr.setUsage(THREE.DynamicDrawUsage)
      exAlphaAttr = new THREE.BufferAttribute(exAlpha, 1)
      exAlphaAttr.setUsage(THREE.DynamicDrawUsage)
      exColAttr = new THREE.BufferAttribute(exCol, 3)
      exColAttr.setUsage(THREE.DynamicDrawUsage)
      eg.setAttribute('position', exPosAttr)
      eg.setAttribute('aAlpha', exAlphaAttr)
      eg.setAttribute('color', exColAttr)
      // park dead particles far below the planet so a 0-alpha point never flickers
      for (let i = 0; i < EXHAUST_COUNT; i++) {
        exPos[i * 3 + 1] = -10000
        exLife[i] = 0
        exMax[i] = EXHAUST_LIFE
        exSeed[i] = Math.random()
      }
      exhaustGeo = eg

      const em = new THREE.PointsMaterial({
        color: 0xffffff, // white base; per-vertex color tints each puff
        vertexColors: true,
        size: EXHAUST_SIZE,
        sizeAttenuation: true,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        toneMapped: false,
        fog: false,
      })
      em.onBeforeCompile = patchPoints
      exhaustMat = em

      const pts = new THREE.Points(eg, em)
      pts.frustumCulled = false
      pts.renderOrder = 997
      ctx.scene.add(pts)
      exhaust = pts

      // ---------------- boost flame pool (afterburner, vertex-colored) ----------------
      flPos = new Float32Array(FLAME_COUNT * 3)
      flAlpha = new Float32Array(FLAME_COUNT)
      flCol = new Float32Array(FLAME_COUNT * 3)
      const fg = new THREE.BufferGeometry()
      flPosAttr = new THREE.BufferAttribute(flPos, 3)
      flPosAttr.setUsage(THREE.DynamicDrawUsage)
      flAlphaAttr = new THREE.BufferAttribute(flAlpha, 1)
      flAlphaAttr.setUsage(THREE.DynamicDrawUsage)
      flColAttr = new THREE.BufferAttribute(flCol, 3)
      flColAttr.setUsage(THREE.DynamicDrawUsage)
      fg.setAttribute('position', flPosAttr)
      fg.setAttribute('aAlpha', flAlphaAttr)
      fg.setAttribute('color', flColAttr)
      for (let i = 0; i < FLAME_COUNT; i++) {
        flPos[i * 3 + 1] = -10000
        flLife[i] = 0
      }
      flameGeo = fg

      const fm = new THREE.PointsMaterial({
        color: 0xffffff,
        vertexColors: true,
        size: FLAME_SIZE,
        sizeAttenuation: true,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        toneMapped: false,
        fog: false,
      })
      fm.onBeforeCompile = patchPoints
      flameMat = fm

      const fpts = new THREE.Points(fg, fm)
      fpts.frustumCulled = false
      fpts.renderOrder = 999 // flame sits on top — it's the hottest light
      ctx.scene.add(fpts)
      flame = fpts

      inited = false // force a ribbon seed on the first update
    },

    update(dt: number, ctx: GameContext) {
      if (
        !ribbonL || !ribbonR || !posL || !posR || !alphaL || !alphaR ||
        !posAttrL || !posAttrR || !alphaAttrL || !alphaAttrR ||
        !exhaust || !exPos || !exAlpha || !exCol || !exPosAttr || !exAlphaAttr || !exColAttr ||
        !flame || !flPos || !flAlpha || !flCol || !flPosAttr || !flAlphaAttr || !flColAttr ||
        !ribbonMat || !exhaustMat || !flameMat
      ) return

      const dtc = Math.min(dt, 1 / 30) // background-resume safety (match Flight)
      const obj = ctx.player.obj
      const speed = ctx.player.flight.speed
      const boosting = boostFlag(ctx)
      const q = quality(ctx)
      const t = ctx.elapsed()

      // contrail intensity: blend boost + how far above cruise we are
      const overCruise = THREE.MathUtils.clamp(
        (speed - TUNING.CRUISE_SPEED) / Math.max(1, TUNING.BOOST_SPEED - TUNING.CRUISE_SPEED),
        0,
        1
      )
      const targetFast = Math.max(boosting ? 1 : 0, overCruise)
      fast += (targetFast - fast) * damp(5, dtc)

      // ---- world frame of the plane ----
      obj.getWorldQuaternion(_q)
      obj.getWorldPosition(_pos)
      _up.set(0, 1, 0).applyQuaternion(_q) // ribbon "flat" axis
      _back.set(0, 0, 1).applyQuaternion(_q) // nose dir (+Z); behind = -_back

      // wingtip anchors in world space (compose from the quaternion-applied local
      // basis to avoid extra temps)
      _tipL.set(-WINGTIP_X, WINGTIP_Y, WINGTIP_Z).applyQuaternion(_q).add(_pos)
      _tipR.set(WINGTIP_X, WINGTIP_Y, WINGTIP_Z).applyQuaternion(_q).add(_pos)

      // ---- seed the ribbon once we have a valid transform ----
      if (!inited) {
        seedRibbon(
          _tipL.x, _tipL.y, _tipL.z,
          _tipR.x, _tipR.y, _tipR.z,
          _up.x, _up.y, _up.z
        )
        lastStampX = _pos.x; lastStampY = _pos.y; lastStampZ = _pos.z
        haveLastStamp = true
        inited = true
      }

      // age every node so the tail dissolves over time too
      for (let i = 0; i < RIBBON_SEGMENTS; i++) nodeAge[i] += dtc

      // ---- stamp a new node when we've travelled far enough (and are moving) ----
      const emitting = speed > EMIT_MIN_SPEED
      let headFade = 1 // how "born" the head node is (0→1) for a bloom-in leading edge
      if (emitting && haveLastStamp) {
        const ddx = _pos.x - lastStampX
        const ddy = _pos.y - lastStampY
        const ddz = _pos.z - lastStampZ
        const moved2 = ddx * ddx + ddy * ddy + ddz * ddz
        if (moved2 >= STAMP_DISTANCE * STAMP_DISTANCE) {
          stampNode(
            _tipL.x, _tipL.y, _tipL.z,
            _tipR.x, _tipR.y, _tipR.z,
            _up.x, _up.y, _up.z
          )
          lastStampX = _pos.x; lastStampY = _pos.y; lastStampZ = _pos.z
        } else {
          // not far enough to drop a new node, but keep the HEAD glued to the live
          // wingtip so the ribbon's leading edge tracks the plane smoothly, and
          // fade the new head in over its travel fraction so it blooms in.
          nodeLX[head] = _tipL.x; nodeLY[head] = _tipL.y; nodeLZ[head] = _tipL.z
          nodeRX[head] = _tipR.x; nodeRY[head] = _tipR.y; nodeRZ[head] = _tipR.z
          sideX[head] = _up.x; sideY[head] = _up.y; sideZ[head] = _up.z
          headFade = THREE.MathUtils.clamp(Math.sqrt(moved2) / STAMP_DISTANCE, 0, 1)
        }
      } else if (!emitting) {
        // parked: let the existing ribbon age out, don't extend it
        haveLastStamp = true
        lastStampX = _pos.x; lastStampY = _pos.y; lastStampZ = _pos.z
      }

      // ---- rebuild ribbon vertex buffers from the node ring ----
      // width swells with `fast` (contrail snap) and tapers toward the tail.
      const headHalfW = RIBBON_HALF_W * (0.7 + fast * 0.8)
      const n = filled
      // global opacity of the ribbon: faint at cruise, bright as a contrail. A
      // gentle shimmer at top speed sells the "crisp contrail" snap.
      const shimmer = 1 + fast * 0.08 * Math.sin(t * 22)
      ribbonMat.opacity = (0.16 + fast * 0.58) * shimmer
      const invSeg = 1 / RIBBON_SEGMENTS
      const invFade = 1 / RIBBON_FADE_SECONDS

      for (let k = 0; k < n; k++) {
        const s = slotOf(k) // node, newest→oldest
        const along = k * invSeg // 0 at head → ~1 at tail
        // tail fade by index (eased) AND by age (whichever dissolves first)
        const idxFade = 1 - along
        const ageFade = THREE.MathUtils.clamp(1 - nodeAge[s] * invFade, 0, 1)
        let a = idxFade * idxFade * ageFade
        if (k === 0) a *= headFade // bloom the leading edge in

        // width tapers down the length → wispy tail, fat head
        const w = headHalfW * (0.35 + 0.65 * idxFade)

        const lcx = nodeLX[s], lcy = nodeLY[s], lcz = nodeLZ[s]
        const rcx = nodeRX[s], rcy = nodeRY[s], rcz = nodeRZ[s]
        const ux = sideX[s] * w, uy = sideY[s] * w, uz = sideZ[s] * w

        const vi = k * 2 // first of the two verts for this ring step
        const p0 = vi * 3
        const p1 = (vi + 1) * 3
        // LEFT ribbon quad edge
        posL[p0] = lcx - ux; posL[p0 + 1] = lcy - uy; posL[p0 + 2] = lcz - uz
        posL[p1] = lcx + ux; posL[p1 + 1] = lcy + uy; posL[p1 + 2] = lcz + uz
        alphaL[vi] = a; alphaL[vi + 1] = a
        // RIGHT ribbon quad edge
        posR[p0] = rcx - ux; posR[p0 + 1] = rcy - uy; posR[p0 + 2] = rcz - uz
        posR[p1] = rcx + ux; posR[p1 + 1] = rcy + uy; posR[p1 + 2] = rcz + uz
        alphaR[vi] = a; alphaR[vi + 1] = a
      }

      const drawVerts = Math.max(0, (n - 1) * 6) // index count for n nodes
      ribbonGeoL!.setDrawRange(0, drawVerts)
      ribbonGeoR!.setDrawRange(0, drawVerts)
      posAttrL.needsUpdate = true
      posAttrR.needsUpdate = true
      alphaAttrL.needsUpdate = true
      alphaAttrR.needsUpdate = true

      // ---------------------- engine exhaust ----------------------
      // emitter just behind the tail
      _emit.copy(_back).multiplyScalar(EXHAUST_Z).add(_pos)

      // spawn rate scales with speed/boost (and quality dial)
      const rate = (BASE_RATE + (BOOST_RATE - BASE_RATE) * fast) * q
      emitAccum += rate * dtc
      let toSpawn = emitAccum | 0
      emitAccum -= toSpawn
      // clamp burst so a long frame can't spike the whole pool at once
      if (toSpawn > 14) toSpawn = 14

      while (toSpawn-- > 0) {
        const i = exCursor
        exCursor = (exCursor + 1) % EXHAUST_COUNT
        // jittered position around the emitter
        const jx = (ctx.rand() - 0.5) * 2 * EXHAUST_SPREAD
        const jy = (ctx.rand() - 0.5) * 2 * EXHAUST_SPREAD
        const jz = (ctx.rand() - 0.5) * 2 * EXHAUST_SPREAD
        const p = i * 3
        exPos[p] = _emit.x + jx
        exPos[p + 1] = _emit.y + jy
        exPos[p + 2] = _emit.z + jz
        // velocity: stream backward (−_back) with a little jitter + buoyant rise
        const drift = EXHAUST_DRIFT * (0.6 + fast * 1.0)
        exVX[i] = -_back.x * drift + jx * 1.6 + _up.x * EXHAUST_RISE
        exVY[i] = -_back.y * drift + jy * 1.6 + _up.y * EXHAUST_RISE
        exVZ[i] = -_back.z * drift + jz * 1.6 + _up.z * EXHAUST_RISE
        const life = EXHAUST_LIFE * (0.8 + ctx.rand() * 0.4)
        exLife[i] = life
        exMax[i] = life
        exSeed[i] = ctx.rand()
      }

      // integrate + fade + recolor all live particles
      for (let i = 0; i < EXHAUST_COUNT; i++) {
        if (exLife[i] <= 0) {
          if (exAlpha[i] !== 0) {
            exAlpha[i] = 0
            exPos[i * 3 + 1] = -10000 // park offscreen
          }
          continue
        }
        exLife[i] -= dtc
        const p = i * 3
        // soft drag so puffs slow and bloom rather than shooting straight
        const drag = 1 - 1.4 * dtc
        exVX[i] *= drag; exVY[i] *= drag; exVZ[i] *= drag
        exPos[p] += exVX[i] * dtc
        exPos[p + 1] += exVY[i] * dtc
        exPos[p + 2] += exVZ[i] * dtc
        const lf = exLife[i] / exMax[i] // 1→0 (remaining)
        const age = 1 - lf // 0→1 (elapsed)
        // ease: bloom in fast, fade out slow; cap intensity by `fast` so cruise is faint
        exAlpha[i] = lf * lf * (0.4 + fast * 0.6)
        // color: hot gold near the nozzle → pale sky vapor as it cools
        const cm = age * age // weight toward vapor late in life
        exCol[p] = _cGold.r + (_cVapor.r - _cGold.r) * cm
        exCol[p + 1] = _cGold.g + (_cVapor.g - _cGold.g) * cm
        exCol[p + 2] = _cGold.b + (_cVapor.b - _cGold.b) * cm
      }

      // puffs swell as they age → handled via base size + per-life alpha; bump
      // overall size a touch with boost so the stream reads thicker.
      exhaustMat.size = EXHAUST_SIZE * (1 + fast * 0.6)
      exPosAttr.needsUpdate = true
      exAlphaAttr.needsUpdate = true
      exColAttr.needsUpdate = true

      // ---------------------- boost flame (afterburner) ----------------------
      // Only ignites with `fast`. Tight, hot jet directly behind the tail.
      _emit.copy(_back).multiplyScalar(FLAME_Z).add(_pos)
      const flIgnite = THREE.MathUtils.smoothstep(fast, 0.25, 0.7) // gate: lights up past a threshold
      flameAccum += FLAME_RATE * flIgnite * q * dtc
      let flSpawn = flameAccum | 0
      flameAccum -= flSpawn
      if (flSpawn > 10) flSpawn = 10

      while (flSpawn-- > 0) {
        const i = flCursor
        flCursor = (flCursor + 1) % FLAME_COUNT
        const jx = (ctx.rand() - 0.5) * 2 * FLAME_SPREAD
        const jy = (ctx.rand() - 0.5) * 2 * FLAME_SPREAD
        const jz = (ctx.rand() - 0.5) * 2 * FLAME_SPREAD
        const p = i * 3
        flPos[p] = _emit.x + jx
        flPos[p + 1] = _emit.y + jy
        flPos[p + 2] = _emit.z + jz
        // fast backward jet with tight spread → reads as thrust
        flVX[i] = -_back.x * FLAME_SPEED + jx * 2.0
        flVY[i] = -_back.y * FLAME_SPEED + jy * 2.0
        flVZ[i] = -_back.z * FLAME_SPEED + jz * 2.0
        flLife[i] = FLAME_LIFE
      }

      for (let i = 0; i < FLAME_COUNT; i++) {
        if (flLife[i] <= 0) {
          if (flAlpha[i] !== 0) {
            flAlpha[i] = 0
            flPos[i * 3 + 1] = -10000
          }
          continue
        }
        flLife[i] -= dtc
        const p = i * 3
        flPos[p] += flVX[i] * dtc
        flPos[p + 1] += flVY[i] * dtc
        flPos[p + 2] += flVZ[i] * dtc
        const lf = flLife[i] / FLAME_LIFE // 1→0
        const age = 1 - lf
        // hot core: bright early, snaps out fast
        flAlpha[i] = lf * (0.55 + flIgnite * 0.45)
        // color: hot coral core → gold as it cools (never reaches pale; it's short)
        flCol[p] = _cHot.r + (_cGold.r - _cHot.r) * age
        flCol[p + 1] = _cHot.g + (_cGold.g - _cHot.g) * age
        flCol[p + 2] = _cHot.b + (_cGold.b - _cHot.b) * age
      }

      // flame breathes slightly + grows with ignition for a punchy plume
      flameMat.size = FLAME_SIZE * (0.85 + flIgnite * 0.5) * (1 + 0.06 * Math.sin(t * 30))
      flPosAttr.needsUpdate = true
      flAlphaAttr.needsUpdate = true
      flColAttr.needsUpdate = true
    },

    dispose() {
      if (ribbonL) { ribbonL.parent?.remove(ribbonL); ribbonL = null }
      if (ribbonR) { ribbonR.parent?.remove(ribbonR); ribbonR = null }
      ribbonGeoL?.dispose(); ribbonGeoR?.dispose()
      ribbonGeoL = null; ribbonGeoR = null
      ribbonMat?.dispose(); ribbonMat = null
      if (exhaust) { exhaust.parent?.remove(exhaust); exhaust = null }
      exhaustGeo?.dispose(); exhaustGeo = null
      exhaustMat?.dispose(); exhaustMat = null
      if (flame) { flame.parent?.remove(flame); flame = null }
      flameGeo?.dispose(); flameGeo = null
      flameMat?.dispose(); flameMat = null
    },
  }
}
