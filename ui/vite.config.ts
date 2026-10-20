import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// Dev: the app talks to the in-browser mock backend unless VITE_UBUS is set, e.g.
//   VITE_UBUS=http://127.0.0.1:8080 npm run dev   (proxied, so the router sees same-origin)
const target = process.env.VITE_UBUS

export default defineConfig({
  plugins: [preact()],
  // Relative asset paths: the build works wherever it is served (uhttpd serves it at /)
  base: './',
  build: { outDir: 'dist', assetsDir: 'assets', chunkSizeWarningLimit: 400 },
  // (vite preview uses the same proxy)
  server: target ? { proxy: { '/ubus': { target, changeOrigin: true }, '/cgi-bin': { target, changeOrigin: true } } } : {},
})
