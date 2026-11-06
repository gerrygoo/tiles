import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  // dev over the tailnet: tailscale serve --bg --https=8444 5173
  server: { host: '127.0.0.1', port: 5173, strictPort: true, allowedHosts: ['.ts.net'] },
})
