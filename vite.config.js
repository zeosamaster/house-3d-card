import { defineConfig } from 'vite';

// One self-contained ES module (three.js included) for HACS to serve from /hacsfiles/.
export default defineConfig({
  build: {
    lib: { entry: 'src/house-3d-card.js', formats: ['es'], fileName: () => 'house-3d-card.js' },
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: { output: { codeSplitting: false } },
  },
});
