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
          if (id.includes('/src/app/legacy-runtime.js')
            || id.includes('/src/game/realm-backgrounds.js')
            || id.includes('/src/game/audio.js')) return 'runtime-legacy';
          if (id.includes('/src/systems/')
            || id.includes('/src/game/entity-world.js')
            || id.includes('/src/game/session.js')
            || id.includes('/src/game/run-build.js')
            || id.includes('/src/game/run-route.js')) return 'gameplay-core';
          if (id.includes('/src/render/')) return 'render-core';
          if (id.includes('/src/content/chapter-chunks/data-city.js')) return 'chapter-data-city';
          if (id.includes('/src/content/chapter-chunks/star-forge.js')) return 'chapter-star-forge';
          if (id.includes('/src/content/chapter-chunks/void-cathedral.js')) return 'chapter-void-cathedral';
          return undefined;
        },
      },
    },
  },
});
