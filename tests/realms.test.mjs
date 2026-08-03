import test from 'node:test';
import assert from 'node:assert/strict';
import { REALMS, getRealm, getRealmByElapsed } from '../src/game/realms.js';

test('four realms own distinct art, music, css and environment identities', () => {
  assert.equal(REALMS.length, 4);
  assert.deepEqual(REALMS.map((realm) => realm.start), [0, 30, 64, 100]);
  assert.equal(new Set(REALMS.map((realm) => realm.id)).size, 4);
  assert.equal(new Set(REALMS.map((realm) => realm.cssTheme)).size, 4);
  assert.equal(new Set(REALMS.map((realm) => realm.music.bpm)).size, 4);
  assert.equal(new Set(REALMS.map((realm) => realm.environment.type)).size, 4);
  assert.equal(getRealm(2).id, 'star-forge');
  assert.equal(getRealmByElapsed(125).id, 'void-cathedral');
});
