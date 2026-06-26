import type { HudBus } from './types'

export function createHudBus(): HudBus {
  const root = document.createElement('div')
  root.id = 'hud'
  root.style.cssText =
    'position:fixed;inset:0;pointer-events:none;font-family:system-ui,-apple-system,sans-serif;color:#fff;z-index:10'
  document.body.appendChild(root)

  function toast(msg: string, ms = 1800) {
    const t = document.createElement('div')
    t.textContent = msg
    t.style.cssText =
      'position:absolute;left:50%;top:16%;transform:translateX(-50%);background:rgba(8,12,28,.62);padding:9px 18px;border-radius:12px;font-weight:600;text-shadow:0 1px 2px #000;transition:opacity .45s;white-space:nowrap'
    root.appendChild(t)
    setTimeout(() => {
      t.style.opacity = '0'
      setTimeout(() => t.remove(), 450)
    }, ms)
  }

  return { root, toast }
}
