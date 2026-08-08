import test from 'node:test';
import assert from 'node:assert/strict';
import { createHudRenderer } from '../src/render/hud-renderer.js';

class FakeClassList {
  toggle() {}
}
class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.classList = new FakeClassList();
    this.textContent = '';
    this.textWrites = 0;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

test('HUD exposes truthful dash progress and changes live phase text only semantically', () => {
  const dashPips = [new FakeElement(), new FakeElement()];
  const dashButton = new FakeElement();
  const dashProgress = new FakeElement();
  const dashRing = new FakeElement();
  const phaseStatus = new FakeElement();
  let phaseText = '';
  Object.defineProperty(phaseStatus, 'textContent', {
    get: () => phaseText,
    set(value) { phaseText = value; phaseStatus.textWrites += 1; },
  });
  const renderer = createHudRenderer({ dashPips, dashButton, dashProgress, dashRing, phaseStatus });
  renderer.render({ dashCharges: [1, 0.35], perfectPhaseWindow: 0.1, inputDevice: 'keyboard' });
  assert.equal(dashProgress.getAttribute('role'), 'progressbar');
  assert.equal(dashProgress.getAttribute('aria-valuemin'), '0');
  assert.equal(dashProgress.getAttribute('aria-valuemax'), '2');
  assert.equal(dashProgress.getAttribute('aria-valuenow'), '1.35');
  assert.match(dashProgress.getAttribute('aria-valuetext'), /1\.35 \/ 2/);
  assert.equal(phaseStatus.getAttribute('role'), 'status');
  assert.equal(phaseStatus.getAttribute('aria-live'), 'polite');
  assert.equal(phaseStatus.textWrites, 1);
  renderer.render({ dashCharges: [1, 0.35], perfectPhaseWindow: 0.09, inputDevice: 'keyboard' });
  assert.equal(phaseStatus.textWrites, 1, 'fixed-frame renders must not spam the live region');
  renderer.render({ dashCharges: [1, 0.35], autoFireRateBuffTimer: 0.7, inputDevice: 'keyboard' });
  assert.equal(phaseStatus.textWrites, 2);
});

test('HUD exposes current objective label, progress, and terminal state accessibly', () => {
  const missionObjective = new FakeElement();
  const missionPanel = new FakeElement();
  const renderer = createHudRenderer({ missionObjective, missionPanel });
  renderer.render({
    objective: { label: '破坏潮汐锚点', progress: 2, target: 4, progressRatio: 0.5, status: 'active' },
  });
  assert.equal(missionObjective.textContent, '破坏潮汐锚点 · 2 / 4');
  assert.equal(missionObjective.dataset.state, 'active');
  assert.equal(missionPanel.attributes.get('aria-label'), '当前任务：破坏潮汐锚点；进度 2 / 4');
  renderer.render({ objective: { label: '破坏潮汐锚点', progress: 4, target: 4, progressRatio: 1, status: 'completed' } });
  assert.equal(missionObjective.dataset.state, 'completed');
});
