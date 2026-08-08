import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENCOUNTER_TEMPLATES,
  OBJECTIVE_TYPES,
  getEncounterTemplate,
  getThreatBudget,
} from '../src/content/encounters.js';

test('encounter content registers one complete authored template per objective type', () => {
  assert.equal(ENCOUNTER_TEMPLATES.length, 8);
  assert.deepEqual(ENCOUNTER_TEMPLATES.map(({ type }) => type).sort(), [...OBJECTIVE_TYPES].sort());
  for (const template of ENCOUNTER_TEMPLATES) {
    assert.ok(template.id);
    assert.ok(template.label);
    assert.ok(Number.isFinite(template.timeout) && template.timeout > 0);
    assert.ok(template.spawnHooks.length > 0);
    assert.ok(template.cleanup.length > 0);
    assert.equal(getEncounterTemplate(template.id), template);
  }
});

test('threat budgets respect mode and quality caps without changing objective rules', () => {
  const template = getEncounterTemplate('purge-tide');
  const desktop = getThreatBudget(template, { mode: 'standard', quality: 'desktop' });
  const mobile = getThreatBudget(template, { mode: 'standard', quality: 'mobile' });
  const abyss = getThreatBudget(template, { mode: 'abyss', quality: 'desktop' });
  assert.deepEqual(Object.keys(desktop).sort(), ['activeEnemyCap', 'projectileCap', 'total']);
  assert.ok(desktop.total > mobile.total);
  assert.ok(abyss.total > desktop.total);
  assert.ok(mobile.activeEnemyCap <= 36);
  assert.ok(abyss.activeEnemyCap <= 56);
});

