import type { EventBus, EventName } from './types'

export function createEventBus(): EventBus {
  const map = new Map<EventName, Set<(p?: any) => void>>()
  return {
    on(type, cb) {
      let s = map.get(type)
      if (!s) {
        s = new Set()
        map.set(type, s)
      }
      s.add(cb)
      return () => s!.delete(cb)
    },
    emit(type, payload) {
      const s = map.get(type)
      if (s) for (const cb of s) cb(payload)
    },
  }
}
