import { defineConfig } from 'vite'

// base './' => relative asset paths, required for Capacitor (loads via file://) on iOS.
// server.host true => reachable from a phone on the LAN for live device testing.
export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
})
