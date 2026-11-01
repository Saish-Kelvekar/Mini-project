import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api/* is forwarded to the Express server on :4000 (the /api prefix is stripped).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: 'http://localhost:4000', rewrite: (p) => p.replace(/^\/api/, '') } } },
});
