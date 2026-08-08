function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

export function createHudRenderer(options = {}) {
  const root = options.root ?? globalThis.document ?? null;
  const dashPips = options.dashPips ?? Array.from(root?.querySelectorAll?.('#dash-pips i') ?? []);
  const dashButton = options.dashButton ?? root?.querySelector?.('#dash-button') ?? null;
  const dashRing = options.dashRing ?? root?.querySelector?.('#dash-ring') ?? null;
  const deviceLabel = options.deviceLabel ?? root?.querySelector?.('#input-device') ?? null;
  const phaseStatus = options.phaseStatus ?? root?.querySelector?.('#phase-status') ?? null;
  let disposed = false;
  let renders = 0;
  let lastSnapshot = null;

  function render(snapshot = {}) {
    if (disposed) return false;
    const charges = Array.isArray(snapshot.dashCharges) ? snapshot.dashCharges.slice(0, 2).map(clamp01) : [0, 0];
    while (charges.length < 2) charges.push(0);
    dashPips.forEach((pip, index) => {
      const charge = charges[index];
      pip.classList.toggle('spent', charge <= 0.001);
      pip.style.opacity = String(0.2 + charge * 0.8);
      pip.style.transform = `skewX(-22deg) scale(${0.78 + charge * 0.22})`;
    });
    const readyCharges = charges.filter((charge) => charge >= 0.999).length;
    dashButton?.classList.toggle('cooldown', readyCharges === 0);
    dashButton?.setAttribute('aria-label', `相位冲刺，${readyCharges} 格可用`);
    dashButton?.setAttribute('aria-disabled', String(readyCharges === 0));
    const firstArc = Math.round(charges[0] * 170);
    const secondArc = 190 + Math.round(charges[1] * 170);
    if (dashRing) {
      dashRing.style.background = `conic-gradient(from -90deg, #ff4fd8 0deg ${firstArc}deg, rgba(255,79,216,.14) ${firstArc}deg 170deg, transparent 170deg 190deg, #64f5ff 190deg ${secondArc}deg, rgba(100,245,255,.14) ${secondArc}deg 360deg)`;
    }
    if (deviceLabel) deviceLabel.textContent = String(snapshot.inputDevice ?? 'keyboard').toUpperCase();
    if (phaseStatus) {
      const perfect = Number(snapshot.perfectPhaseWindow) > 0;
      const phased = Number(snapshot.phaseTimer) > 0;
      const buffed = Number(snapshot.autoFireRateBuffTimer) > 0;
      phaseStatus.textContent = perfect ? 'PERFECT WINDOW' : phased ? 'PHASED' : buffed ? 'SURGE' : 'READY';
      phaseStatus.dataset.state = perfect ? 'perfect' : phased ? 'phase' : buffed ? 'buff' : 'ready';
    }
    lastSnapshot = Object.freeze({ ...snapshot, dashCharges: Object.freeze(charges) });
    renders += 1;
    return true;
  }

  function getDebugSnapshot() {
    return Object.freeze({ disposed, renders, lastSnapshot });
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    return true;
  }

  return Object.freeze({ render, getDebugSnapshot, dispose });
}
