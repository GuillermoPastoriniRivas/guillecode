import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  publicDir: 'pwa-public',
  build: {
    outDir: 'dist-pwa',
    emptyOutDir: true,
    rollupOptions: { input: 'pwa.html' },
  },
})
