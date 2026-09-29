import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

function releaseSecretsGuard(): Plugin {
  return {
    name: 'release-secrets-guard',
    apply: 'build',
    generateBundle(_options, bundle) {
      const env = loadEnv('production', process.cwd(), 'VITE_')
      const secrets = Object.entries(env).filter(([name, value]) => /PASSWORD|TOKEN|SECRET|API_KEY/i.test(name) && value.length > 0)
      for (const [name, value] of secrets) {
        if (Object.values(bundle).some((item) => item.type === 'chunk' && item.code.includes(value))) {
          this.error(`El release contiene ${name}. No se puede distribuir una credencial de desarrollo.`)
        }
      }
    },
  }
}

// Proxy a opencode serve (evita CORS en dev; en Tauri no hace falta).
// El Authorization lo adjunta el cliente del browser (ver src/lib/opencode.ts).
const target = process.env.OPENCODE_URL ?? 'http://localhost:4096'

export default defineConfig({
  plugins: [react(), releaseSecretsGuard()],
  // Tauri: puerto fijo (devUrl apunta acá) y no tapar errores con el screen clear.
  clearScreen: false,
  envPrefix: ['VITE_'],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/oc': {
        target,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/oc/, ''),
      },
    },
  },
})
