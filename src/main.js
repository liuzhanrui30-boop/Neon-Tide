import { bootstrapNeonTide } from './app/bootstrap.js';

const app = bootstrapNeonTide();
window.addEventListener('pagehide', () => app.dispose(), { once: true });
