import { defineConfig } from 'vite';

// Relative asset URLs keep the game working on root domains, subpaths,
// GitHub Pages project sites, and itch.io HTML5 embeds.
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'vendor-three';
          if (id.includes('/src/content/chapter-chunks/data-city.js')) return 'chapter-data-city';
          if (id.includes('/src/content/chapter-chunks/star-forge.js')) return 'chapter-star-forge';
          if (id.includes('/src/content/chapter-chunks/void-cathedral.js')) return 'chapter-void-cathedral';
          return undefined;
        },
      },
    },
  },
});
