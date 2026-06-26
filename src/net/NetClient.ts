import type { PlaneState } from '../plane/PlaneState'

// The game never imports WebSocket directly — it talks to this interface, so the
// transport is swappable. Single-player ships the no-op NullNetClient; the
// multiplayer phase swaps in a PartyNetClient with the same surface (no game rewrite).
export interface NetClient {
  readonly connected: boolean
  connect(): void
  sendState(s: PlaneState): void
  serverNow(): number
}

export class NullNetClient implements NetClient {
  readonly connected = false
  connect(): void {}
  sendState(_s: PlaneState): void {}
  serverNow(): number {
    return performance.now()
  }
}
