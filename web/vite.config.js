import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The API bearer token never reaches the browser.
//
// The dev proxy runs in Node, so it can attach Authorization on the way through
// while the bundle stays free of a credential that unlocks a complete picture of
// one person's net worth. Anything shipped to the browser is readable by anyone
// with devtools and lives forever in the bundle.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }
  const token = env.FINGOD_API_TOKEN
  const target = env.FINGOD_API_ORIGIN || 'http://127.0.0.1:8080'

  if (!token) {
    console.warn(
      '\n  FINGOD_API_TOKEN is not set — every /api call will 401.\n' +
      '  Start with `make web`, which sources .env first.\n'
    )
  }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target,
          changeOrigin: false,
          configure(proxy) {
            proxy.on('proxyReq', (proxyReq) => {
              if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`)
            })
          },
        },
      },
    },
    build: { outDir: 'dist', sourcemap: true },
  }
})
