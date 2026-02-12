import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build timestamp: YYMMDD-HHmm (e.g., "250212-0035")
const now = new Date();
const buildId = [
  String(now.getFullYear()).slice(2),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
  '-',
  String(now.getHours()).padStart(2, '0'),
  String(now.getMinutes()).padStart(2, '0'),
].join('');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3060,
    host: '0.0.0.0',
  },
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
    '__APP_VERSION__': JSON.stringify(buildId),
  },
});
