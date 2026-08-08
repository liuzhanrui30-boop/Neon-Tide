function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function formatObjectiveUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  if (Math.abs(number - Math.round(number)) < 0.01) return String(Math.round(number));
  return number.toFixed(1);
}

export function createHudRenderer(options = {}) {
  const root = options.root ?? globalThis.document ?? null;
  const dashPips = options.dashPips ?? Array.from(root?.querySelectorAll?.('#dash-pips i') ?? []);
  const dashProgress = options.dashProgress ?? root?.querySelector?.('#dash-pips') ?? null;
  const dashButton = options.dashButton ?? root?.querySelector?.('#dash-button') ?? null;
  const dashRing = options.dashRing ?? root?.querySelector?.('#dash-ring') ?? null;
  const deviceLabel = options.deviceLabel ?? root?.querySelector?.('#input-device') ?? null;
  const phaseStatus = options.phaseStatus ?? root?.querySelector?.('#phase-status') ?? null;
  const missionPanel = options.missionPanel ?? root?.querySelector?.('#mission-panel') ?? null;
  const missionObjective = options.missionObjective ?? root?.querySelector?.('#mission-objective') ?? null;
  let disposed = false;
  let renders = 0;
  let lastSnapshot = null;
  let lastPhaseState = null;
  dashProgress?.setAttribute('role', 'progressbar');
  dashProgress?.setAttribute('aria-label', '相位冲刺充能');
  dashProgress?.setAttribute('aria-valuemin', '0');
  dashProgress?.setAttribute('aria-valuemax', '2');
  phaseStatus?.setAttribute('role', 'status');
  phaseStatus?.setAttribute('aria-live', 'polite');
  phaseStatus?.setAttribute('aria-atomic', 'true');

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
    const chargeTotal = Math.round((charges[0] + charges[1]) * 100) / 100;
    const readyCharges = charges.filter((charge) => charge >= 0.999).length;
    dashProgress?.setAttribute('aria-valuenow', String(chargeTotal));
    dashProgress?.setAttribute('aria-valuetext', `相位冲刺 ${chargeTotal.toFixed(2)} / 2；${readyCharges} 格就绪`);
    dashButton?.classList.toggle('cooldown', readyCharges === 0);
    dashButton?.setAttribute('aria-label', `相位冲刺，${readyCharges} 格可用`);
    dashButton?.setAttribute('aria-disabled', String(readyCharges === 0));
    const firstArc = Math.round(charges[0] * 170);
    const secondArc = 190 + Math.round(charges[1] * 170);
    if (dashRing) {
      dashRing.style.background = `conic-gradient(from -90deg, #ff4fd8 0deg ${firstArc}deg, rgba(255,79,216,.14) ${firstArc}deg 170deg, transparent 170deg 190deg, #64f5ff 190deg ${secondArc}deg, rgba(100,245,255,.14) ${secondArc}deg 360deg)`;
    }
    const deviceText = String(snapshot.inputDevice ?? 'keyboard').toUpperCase();
    if (deviceLabel && deviceLabel.textContent !== deviceText) deviceLabel.textContent = deviceText;
    if (phaseStatus) {
      const perfect = Number(snapshot.perfectPhaseWindow) > 0;
      const phased = Number(snapshot.phaseTimer) > 0;
      const buffed = Number(snapshot.autoFireRateBuffTimer) > 0;
      const phaseState = perfect ? 'perfect' : phased ? 'phase' : buffed ? 'buff' : 'ready';
      if (phaseState !== lastPhaseState) {
        const phaseText = perfect ? '完美相位窗口' : phased ? '相位中' : buffed ? '武器涌流' : '相位就绪';
        phaseStatus.textContent = phaseText;
        phaseStatus.dataset.state = phaseState;
        lastPhaseState = phaseState;
      }
    }
    if (snapshot.objective && missionObjective) {
      const objective = snapshot.objective;
      const label = String(objective.label ?? objective.type ?? '当前任务');
      const progress = formatObjectiveUnit(objective.progress);
      const target = formatObjectiveUnit(objective.target);
      const text = `${label} · ${progress} / ${target}`;
      if (missionObjective.textContent !== text) missionObjective.textContent = text;
      missionObjective.dataset.state = String(objective.status ?? 'active');
      missionObjective.setAttribute('role', 'status');
      missionObjective.setAttribute('aria-live', 'polite');
      missionPanel?.setAttribute('aria-label', `当前任务：${label}；进度 ${progress} / ${target}`);
      missionPanel?.setAttribute('data-objective-type', String(objective.type ?? 'unknown'));
      missionPanel?.setAttribute('data-objective-state', String(objective.status ?? 'active'));
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
