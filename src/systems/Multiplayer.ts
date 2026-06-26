import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'

/*
 * MATCHING RELAY SERVER (deferred — not in this repo yet).
 * --------------------------------------------------------
 * This client speaks a tiny JSON protocol to a stateless WebSocket relay (a ~80-line
 * Node `ws` / Cloudflare-Durable-Object / PartyKit room would do). On connect the server
 * assigns the socket a short string id and replies `{t:'hello', id, now}` where `now` is the
 * server clock in ms (used to seed a one-shot clock offset for snapshot timestamps). Thereafter
 * the client pushes `{t:'s', ...PlaneState}` at ~15Hz; the relay fans each state out to every
 * OTHER socket in the room verbatim, stamping the sender's `id`, as `{t:'s', id, ...}`. The relay
 * keeps no physics and trusts no client — it is a pure mirror, so it scales trivially and a
 * malicious peer can only move its own ghost plane. Disconnects fan out `{t:'bye', id}` so peers
 * can retire that ghost. No URL / failed handshake / closed socket all degrade silently to a
 * no-op: single-player is never blocked on the network. Interpolation, not the wire format, is
 * the load-bearing part here, so the protocol stays human-readable JSON for now and can be
 * swapped for a packed binary frame later without touching the game.
 */

// ---- wire protocol -------------------------------------------------------------------------

const SEND_HZ = 15
const SEND_INTERVAL = 1 / SEND_HZ
const INTERP_DELAY = 0.1 // 100ms render-behind buffer
const BUFFER_MAX = 12 // ring capacity per remote (>= INTERP_DELAY*SEND_HZ + slack)
const REMOTE_TIMEOUT = 5 // seconds of silence before a ghost is culled
const MAX_REMOTES = 24 // hard cap (mobile perf): ignore peers beyond this

const FLAG_BOOST = 1 << 0
const FLAG_ROLL = 1 << 1

interface HelloMsg {
  t: 'hello'
  id: string
  now: number
}
interface StateMsg {
  t: 's'
  id?: string
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  f: number
  ts: number
}
interface ByeMsg {
  t: 'bye'
  id: string
}
type ServerMsg = HelloMsg | StateMsg | ByeMsg

// The compact local-plane state we put on the wire (pos + quat + flags + timestamp).
interface LocalState {
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  f: number
}

// ---- self-contained NetClient (mirrors src/net/NetClient.ts surface) ------------------------

interface NetCallbacks {
  onState(id: string, m: StateMsg): void
  onBye(id: string): void
}

/**
 * WebSocketNetClient — connect/sendState/serverNow/connected, same shape as the project's
 * NetClient interface but kept local so this module is fully self-contained. Every failure
 * mode (no URL, refused, error, close) leaves `connected === false` and turns sends into no-ops.
 */
class WebSocketNetClient {
  connected = false
  private ws: WebSocket | null = null
  private url: string | undefined
  private clockOffset = 0 // serverNow - performance.now(), seeded from hello
  private cbs: NetCallbacks
  private closed = false

  constructor(url: string | undefined, cbs: NetCallbacks) {
    this.url = url
    this.cbs = cbs
  }

  connect(): void {
    if (this.closed || !this.url) return
    if (typeof WebSocket === 'undefined') return // SSR / unsupported env: stay no-op
    let sock: WebSocket
    try {
      sock = new WebSocket(this.url)
    } catch {
      return // malformed URL etc. — degrade to single-player
    }
    this.ws = sock
    sock.onopen = () => {
      if (this.ws === sock) this.connected = true
    }
    sock.onmessage = (ev) => {
      this.onMessage(ev.data)
    }
    sock.onerror = () => {
      this.connected = false
    }
    sock.onclose = () => {
      if (this.ws === sock) {
        this.connected = false
        this.ws = null
      }
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return // binary path reserved for later
    let msg: ServerMsg
    try {
      msg = JSON.parse(data) as ServerMsg
    } catch {
      return
    }
    if (msg.t === 'hello') {
      if (typeof msg.now === 'number' && isFinite(msg.now)) {
        this.clockOffset = msg.now - performance.now()
      }
    } else if (msg.t === 's') {
      if (typeof msg.id === 'string') this.cbs.onState(msg.id, msg)
    } else if (msg.t === 'bye') {
      if (typeof msg.id === 'string') this.cbs.onBye(msg.id)
    }
  }

  // Reusable wire buffer — zero allocation on the hot send path.
  private wire: StateMsg = {
    t: 's',
    px: 0,
    py: 0,
    pz: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    f: 0,
    ts: 0,
  }

  sendState(s: LocalState): void {
    const ws = this.ws
    if (!this.connected || !ws || ws.readyState !== 1) return
    const w = this.wire
    w.px = s.px
    w.py = s.py
    w.pz = s.pz
    w.qx = s.qx
    w.qy = s.qy
    w.qz = s.qz
    w.qw = s.qw
    w.f = s.f
    w.ts = this.serverNow()
    try {
      ws.send(JSON.stringify(w))
    } catch {
      // transient — next tick retries; nothing to clean up
    }
  }

  serverNow(): number {
    return performance.now() + this.clockOffset
  }

  dispose(): void {
    this.closed = true
    this.connected = false
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- snapshot buffer per remote -------------------------------------------------------------

// A fixed-size ring of timestamped snapshots. Preallocated quats/vec3 → no per-frame GC.
class RemoteGhost {
  readonly obj: THREE.Object3D
  // parallel ring arrays (struct-of-arrays keeps allocation flat)
  private ts = new Float64Array(BUFFER_MAX)
  private px = new Float32Array(BUFFER_MAX)
  private py = new Float32Array(BUFFER_MAX)
  private pz = new Float32Array(BUFFER_MAX)
  private qx = new Float32Array(BUFFER_MAX)
  private qy = new Float32Array(BUFFER_MAX)
  private qz = new Float32Array(BUFFER_MAX)
  private qw = new Float32Array(BUFFER_MAX)
  private head = 0 // index of newest sample
  private count = 0
  lastSeenServerTs = 0 // server clock of newest sample (for interpolation)
  lastRecvLocal = 0 // local elapsed() of last packet (for timeout culling)

  constructor(obj: THREE.Object3D) {
    this.obj = obj
  }

  push(m: StateMsg, nowLocal: number): void {
    // Drop out-of-order/stale packets relative to newest buffered sample.
    if (this.count > 0 && m.ts <= this.ts[this.head]) {
      this.lastRecvLocal = nowLocal
      return
    }
    this.head = (this.head + 1) % BUFFER_MAX
    const i = this.head
    this.ts[i] = m.ts
    this.px[i] = m.px
    this.py[i] = m.py
    this.pz[i] = m.pz
    this.qx[i] = m.qx
    this.qy[i] = m.qy
    this.qz[i] = m.qz
    this.qw[i] = m.qw
    if (this.count < BUFFER_MAX) this.count++
    this.lastSeenServerTs = m.ts
    this.lastRecvLocal = nowLocal
  }

  // Sample the buffer at renderTime (server clock). Writes into outPos/outQuat.
  // Returns false if there is not enough data to position the ghost yet.
  sample(renderTime: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
    const n = this.count
    if (n === 0) return false
    if (n === 1) {
      const i = this.head
      outPos.set(this.px[i], this.py[i], this.pz[i])
      outQuat.set(this.qx[i], this.qy[i], this.qz[i], this.qw[i])
      return true
    }
    // Walk newest→oldest to find the pair [older, newer] bracketing renderTime.
    let newer = this.head
    for (let step = 0; step < n - 1; step++) {
      const older = (newer - 1 + BUFFER_MAX) % BUFFER_MAX
      const tNew = this.ts[newer]
      const tOld = this.ts[older]
      if (renderTime >= tOld) {
        if (renderTime >= tNew) {
          // Ahead of newest sample → clamp (brief extrapolation-free hold).
          outPos.set(this.px[newer], this.py[newer], this.pz[newer])
          outQuat.set(this.qx[newer], this.qy[newer], this.qz[newer], this.qw[newer])
          return true
        }
        const span = tNew - tOld
        const a = span > 1e-4 ? (renderTime - tOld) / span : 1
        outPos.set(
          this.px[older] + (this.px[newer] - this.px[older]) * a,
          this.py[older] + (this.py[newer] - this.py[older]) * a,
          this.pz[older] + (this.pz[newer] - this.pz[older]) * a,
        )
        _qa.set(this.qx[older], this.qy[older], this.qz[older], this.qw[older])
        _qb.set(this.qx[newer], this.qy[newer], this.qz[newer], this.qw[newer])
        outQuat.slerpQuaternions(_qa, _qb, a)
        return true
      }
      newer = older
    }
    // renderTime is older than everything buffered → snap to oldest.
    outPos.set(this.px[newer], this.py[newer], this.pz[newer])
    outQuat.set(this.qx[newer], this.qy[newer], this.qz[newer], this.qw[newer])
    return true
  }
}

// ---- module-scoped temps (zero per-frame allocation) ----------------------------------------

const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()
const _samplePos = new THREE.Vector3()
const _sampleQuat = new THREE.Quaternion()
const _local: LocalState = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, f: 0 }

// ---- ghost mesh (shared low-poly pastel plane silhouette) -----------------------------------

// A simple, cohesive low-poly plane: a tapered body + flat wing + tail. Remote planes are
// deliberately NOT coral (the local plane is the only coral object) — they read as soft sky-blue
// peers. One shared geometry/material per ghost via cloned material tint; geometry is shared.
function buildGhostGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []

  const body = new THREE.ConeGeometry(0.9, 4.4, 6)
  body.rotateX(Math.PI / 2) // nose along +Z (matches plane forward convention)
  parts.push(body)

  const wing = new THREE.BoxGeometry(6.2, 0.18, 1.3)
  wing.translate(0, 0, -0.2)
  parts.push(wing)

  const tailWing = new THREE.BoxGeometry(2.4, 0.16, 0.8)
  tailWing.translate(0, 0, -2.0)
  parts.push(tailWing)

  const fin = new THREE.BoxGeometry(0.16, 1.1, 0.9)
  fin.translate(0, 0.5, -2.0)
  parts.push(fin)

  const merged = mergeSimple(parts)
  for (const p of parts) p.dispose()
  merged.computeVertexNormals()
  return merged
}

// Minimal non-indexed geometry merge (avoids importing BufferGeometryUtils for one call).
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0
  const nonIndexed: THREE.BufferGeometry[] = []
  for (const g of geos) {
    const ni = g.index ? g.toNonIndexed() : g
    nonIndexed.push(ni)
    total += ni.getAttribute('position').count
  }
  const positions = new Float32Array(total * 3)
  let offset = 0
  for (const g of nonIndexed) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    positions.set(pos.array as Float32Array, offset)
    offset += pos.array.length
  }
  // dispose temporaries we created via toNonIndexed
  for (let i = 0; i < geos.length; i++) {
    if (nonIndexed[i] !== geos[i]) nonIndexed[i].dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return out
}

// ---- the system -----------------------------------------------------------------------------

export function createMultiplayerSystem(url?: string): GameSystem {
  const ghosts = new Map<string, RemoteGhost>()
  let ghostGeo: THREE.BufferGeometry | null = null
  let ghostMat: THREE.MeshStandardMaterial | null = null
  let boostMat: THREE.MeshStandardMaterial | null = null
  let net: WebSocketNetClient | null = null
  let group: THREE.Group | null = null
  let sceneRef: THREE.Scene | null = null
  let sendAccum = 0
  let announced = false

  // Buffer remote states until update() can apply them (decouples socket cb from frame).
  // Use a small fixed inbox so the network callback never allocates per-message beyond JSON.
  function onState(id: string, m: StateMsg): void {
    if (!sceneRef || !group || !ghostGeo) return
    let g = ghosts.get(id)
    if (!g) {
      if (ghosts.size >= MAX_REMOTES) return // perf cap: ignore overflow peers
      const mesh = new THREE.Mesh(ghostGeo, ghostMat!)
      mesh.frustumCulled = true
      mesh.matrixAutoUpdate = true
      g = new RemoteGhost(mesh)
      ghosts.set(id, g)
      group.add(mesh)
    }
    g.push(m, lastElapsed)
    // swap material tint when a peer is boosting (cheap visual telegraphy)
    const mesh = g.obj as THREE.Mesh
    const boosting = (m.f & FLAG_BOOST) !== 0
    const want = boosting ? boostMat! : ghostMat!
    if (mesh.material !== want) mesh.material = want
  }

  function onBye(id: string): void {
    const g = ghosts.get(id)
    if (!g) return
    ghosts.delete(id)
    if (group) group.remove(g.obj)
  }

  let lastElapsed = 0

  return {
    name: 'multiplayer',

    init(ctx: GameContext): void {
      sceneRef = ctx.scene
      group = new THREE.Group()
      group.name = 'remote-planes'
      ctx.scene.add(group)

      ghostGeo = buildGhostGeometry()
      // Soft sky-blue peers (NOT coral) — flat-ish, cozy pastel, cheap lighting response.
      ghostMat = new THREE.MeshStandardMaterial({
        color: PAL.skyTop.clone(),
        roughness: 0.85,
        metalness: 0.0,
        flatShading: true,
      })
      boostMat = ghostMat.clone()
      boostMat.color.copy(PAL.gem)
      boostMat.emissive.copy(PAL.gem).multiplyScalar(0.25)

      net = new WebSocketNetClient(url, { onState, onBye })
      net.connect()
    },

    update(dt: number, ctx: GameContext): void {
      lastElapsed = ctx.elapsed()
      if (!net || !group) return

      // 1) Send local plane state at a fixed ~15Hz (independent of frame rate).
      if (net.connected) {
        sendAccum += dt
        if (sendAccum >= SEND_INTERVAL) {
          sendAccum %= SEND_INTERVAL // drop accumulated backlog, keep phase
          const p = ctx.player.obj
          _local.px = p.position.x
          _local.py = p.position.y
          _local.pz = p.position.z
          _local.qx = p.quaternion.x
          _local.qy = p.quaternion.y
          _local.qz = p.quaternion.z
          _local.qw = p.quaternion.w
          let f = 0
          if (ctx.player.flight.boosting) f |= FLAG_BOOST
          if (ctx.player.flight.rolling) f |= FLAG_ROLL
          _local.f = f
          net.sendState(_local)
        }
        if (!announced) {
          announced = true
          ctx.hud.toast('Connected — flying with friends', 2000)
        }
      }

      // 2) Render-behind interpolation for every ghost; cull silent peers.
      const renderTime = net.serverNow() - INTERP_DELAY * 1000
      const nowLocal = ctx.elapsed()
      for (const [id, g] of ghosts) {
        if (nowLocal - g.lastRecvLocal > REMOTE_TIMEOUT) {
          ghosts.delete(id)
          group.remove(g.obj)
          continue
        }
        if (g.sample(renderTime, _samplePos, _sampleQuat)) {
          g.obj.position.copy(_samplePos)
          g.obj.quaternion.copy(_sampleQuat)
        }
      }
    },

    dispose(): void {
      if (net) {
        net.dispose()
        net = null
      }
      if (group && sceneRef) {
        sceneRef.remove(group)
        for (const g of ghosts.values()) group.remove(g.obj)
      }
      ghosts.clear()
      if (ghostGeo) {
        ghostGeo.dispose()
        ghostGeo = null
      }
      if (ghostMat) {
        ghostMat.dispose()
        ghostMat = null
      }
      if (boostMat) {
        boostMat.dispose()
        boostMat = null
      }
      group = null
      sceneRef = null
    },
  }
}
