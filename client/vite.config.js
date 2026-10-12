import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API is proxied, so VITE_API_URL can stay empty and no CORS is involved.
// In production (Vercel), set VITE_API_URL to the Render URL.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
});
