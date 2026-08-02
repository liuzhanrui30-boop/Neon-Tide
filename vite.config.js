import { defineConfig } from 'vite';

// Relative asset URLs keep the game working on root domains, subpaths,
// GitHub Pages project sites, and itch.io HTML5 embeds.
export default defineConfig({
  base: './',
});
