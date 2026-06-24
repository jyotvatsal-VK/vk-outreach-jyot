import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Firebase in its own chunk — largest dependency
          'firebase-core': ['firebase/app', 'firebase/auth'],
          'firebase-db':   ['firebase/firestore'],
          // xlsx in its own chunk — only loaded when importing/exporting
          'xlsx':          ['xlsx'],
          // React + ReactDOM together
          'react-vendor':  ['react', 'react-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
