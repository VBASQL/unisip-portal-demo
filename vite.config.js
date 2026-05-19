import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// base is '/' in dev, '/unisip-portal-demo/' in production build (GitHub Pages)
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/unisip-portal-demo/' : '/',
}))
