import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3060,
    host: '0.0.0.0',
  },
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
});
