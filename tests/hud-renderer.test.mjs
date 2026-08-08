import test from 'node:test';
import assert from 'node:assert/strict';
import { createHudRenderer, createUpgradeOfferViewModel } from '../src/render/hud-renderer.js';
import { attachPendingOffer, createUpgradeBuild } from '../src/systems/upgrade-system.js';

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

test('objective-only HUD renders preserve player state and throttle live announcements', () => {
  const dashPips = [new FakeElement(), new FakeElement()];
  const dashProgress = new FakeElement();
  const deviceLabel = new FakeElement();
  const missionObjective = new FakeElement();
  const objectiveStatus = new FakeElement();
  const renderer = createHudRenderer({ dashPips, dashProgress, deviceLabel, missionObjective, objectiveStatus });
  renderer.render({ dashCharges: [1, 0.5], inputDevice: 'gamepad', phaseTimer: 0.2 });
  renderer.render({ objective: { label: '移动占领', progress: 0.11, target: 12, progressRatio: 0.009, status: 'active' } });
  renderer.render({ objective: { label: '移动占领', progress: 0.12, target: 12, progressRatio: 0.01, status: 'active' } });
  assert.equal(dashProgress.getAttribute('aria-valuenow'), '1.5');
  assert.equal(deviceLabel.textContent, 'GAMEPAD');
  assert.ok(objectiveStatus.textWrites <= 1);
  assert.deepEqual(renderer.getDebugSnapshot().lastSnapshot.dashCharges, [1, 0.5]);
});

test('HUD stores and exposes only a detached immutable objective view model', () => {
  const missionObjective = new FakeElement();
  const renderer = createHudRenderer({ missionObjective });
  const authoritative = {
    label: '破坏潮汐锚点', type: 'anchors', status: 'active', progress: 1,
    target: 3, progressRatio: 1 / 3, anchors: [{ x: 4, y: 2 }],
  };
  renderer.render({ objective: authoritative });
  const objective = renderer.getDebugSnapshot().lastSnapshot.objective;
  assert.notEqual(objective, authoritative);
  assert.equal(Object.isFrozen(objective), true);
  assert.deepEqual(Object.keys(objective).sort(), ['label', 'progress', 'progressRatio', 'status', 'target', 'type']);
  assert.equal('anchors' in objective, false);
  authoritative.progress = 2;
  authoritative.anchors[0].x = 999;
  assert.equal(objective.progress, 1);
  assert.throws(() => { objective.progress = 99; }, TypeError);
});

test('upgrade cards expose behavior, current to new stack, tags and starter compatibility', () => {
  const build = attachPendingOffer(createUpgradeBuild({ starterWeapon: 'pulse-cannon' }), 77);
  const view = createUpgradeOfferViewModel(build, 'zhCN');
  assert.equal(view.cards.length, 3);
  assert.equal(Object.isFrozen(view), true);
  for (const card of view.cards) {
    assert.ok(card.name);
    assert.ok(card.behavior);
    assert.match(card.stackLabel, /0 → 1/);
    assert.ok(card.tags.length > 0);
    assert.equal(card.compatible, true);
    assert.equal(card.starterWeapon, 'pulse-cannon');
  }
});
