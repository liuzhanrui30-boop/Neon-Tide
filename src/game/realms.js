const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
};

export const REALMS = freeze([
  { index: 0, id: 'abyss', start: 0, end: 30, cssTheme: 'abyss', music: { bpm: 92, root: 45, scale: [0, 3, 5, 7, 10] }, environment: { type: 'current', interval: [7, 10], telegraph: 0.8 } },
  { index: 1, id: 'data-city', start: 30, end: 64, cssTheme: 'data-city', music: { bpm: 116, root: 50, scale: [0, 2, 5, 7, 9] }, environment: { type: 'data-lane', interval: [8, 11], telegraph: 0.9 } },
  { index: 2, id: 'star-forge', start: 64, end: 100, cssTheme: 'star-forge', music: { bpm: 132, root: 40, scale: [0, 1, 5, 7, 8] }, environment: { type: 'gravity-well', interval: [9, 12], telegraph: 1 } },
  { index: 3, id: 'void-cathedral', start: 100, end: 126, cssTheme: 'void-cathedral', music: { bpm: 140, root: 38, scale: [0, 1, 6, 7, 11] }, environment: { type: 'none', interval: [Infinity, Infinity], telegraph: 0 } },
]);

export const getRealm = (index = 0) => REALMS[Math.min(REALMS.length - 1, Math.max(0, Math.trunc(Number(index) || 0)))];
export const getRealmByElapsed = (elapsed = 0) => REALMS.findLast((realm) => Math.max(0, Number(elapsed) || 0) >= realm.start) ?? REALMS[0];
