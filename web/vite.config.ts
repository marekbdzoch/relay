import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.RELAY_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target, changeOrigin: true },
      '/socket.io': { target, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 2000 },
});
