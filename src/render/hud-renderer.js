import { getUpgradeById, createUpgradeBuild } from '../systems/upgrade-system.js';

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

const objectiveViewModels = new WeakSet();

export function createHudObjectiveViewModel(objective) {
  if (!objective || typeof objective !== 'object') return null;
  if (objectiveViewModels.has(objective)) return objective;
  const progress = Number(objective.progress);
  const target = Number(objective.target);
  const viewModel = Object.freeze({
    label: String(objective.label ?? objective.type ?? '当前任务'),
    type: String(objective.type ?? 'unknown'),
    status: String(objective.status ?? 'active'),
    progress: Number.isFinite(progress) ? progress : 0,
    target: Number.isFinite(target) ? target : 0,
    progressRatio: clamp01(objective.progressRatio),
  });
  objectiveViewModels.add(viewModel);
  return viewModel;
}

export function createUpgradeOfferViewModel(build, locale = 'zhCN') {
  const normalized = createUpgradeBuild(build);
  const cards = (normalized.pendingOffer?.cards ?? []).map((id, index) => {
    const definition = getUpgradeById(id);
    const currentStack = normalized.upgradeStacks[id] ?? 0;
    const localized = definition.copy[locale] ?? definition.copy.zhCN;
    return Object.freeze({
      id,
      number: index + 1,
      name: localized.name,
      behavior: localized.behavior,
      currentStack,
      nextStack: currentStack + 1,
      maxStacks: definition.maxStacks,
      stackLabel: `${currentStack} → ${currentStack + 1} / ${definition.maxStacks}`,
      tags: Object.freeze([...definition.tags]),
      compatibleStarterWeapons: Object.freeze([...definition.compatibleStarterWeapons]),
      starterWeapon: normalized.starterWeapon,
      compatible: definition.compatibleStarterWeapons.includes(normalized.starterWeapon),
      bossCore: definition.bossCore,
    });
  });
  return Object.freeze({
    rewardKind: normalized.pendingOffer?.rewardKind ?? null,
    starterWeapon: normalized.starterWeapon,
    cards: Object.freeze(cards),
  });
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
  const upgradeOptions = options.upgradeOptions ?? root?.querySelector?.('#upgrade-options') ?? null;
  let objectiveStatus = options.objectiveStatus ?? root?.querySelector?.('[data-objective-live]') ?? null;
  if (!objectiveStatus && root?.createElement && missionPanel?.append) {
    objectiveStatus = root.createElement('span');
    objectiveStatus.dataset.objectiveLive = 'true';
    objectiveStatus.className = 'sr-only';
    missionPanel.append(objectiveStatus);
  }
  let disposed = false;
  let renders = 0;
  let lastSnapshot = null;
  let lastPhaseState = null;
  let lastObjectiveAnnouncementKey = null;
  dashProgress?.setAttribute('role', 'progressbar');
  dashProgress?.setAttribute('aria-label', '相位冲刺充能');
  dashProgress?.setAttribute('aria-valuemin', '0');
  dashProgress?.setAttribute('aria-valuemax', '2');
  phaseStatus?.setAttribute('role', 'status');
  phaseStatus?.setAttribute('aria-live', 'polite');
  phaseStatus?.setAttribute('aria-atomic', 'true');
  objectiveStatus?.setAttribute('role', 'status');
  objectiveStatus?.setAttribute('aria-live', 'polite');
  objectiveStatus?.setAttribute('aria-atomic', 'true');

  function render(snapshot = {}) {
    if (disposed) return false;
    const objective = Object.hasOwn(snapshot, 'objective')
      ? createHudObjectiveViewModel(snapshot.objective)
      : lastSnapshot?.objective ?? null;
    const merged = { ...(lastSnapshot ?? {}), ...snapshot, objective };
    const hasPhaseUpdate = ['perfectPhaseWindow', 'phaseTimer', 'autoFireRateBuffTimer']
      .some((key) => Object.hasOwn(snapshot, key));
    if (hasPhaseUpdate) {
      for (const key of ['perfectPhaseWindow', 'phaseTimer', 'autoFireRateBuffTimer']) {
        if (!Object.hasOwn(snapshot, key)) merged[key] = 0;
      }
    }
    const charges = Array.isArray(merged.dashCharges) ? merged.dashCharges.slice(0, 2).map(clamp01) : [0, 0];
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
    const deviceText = String(merged.inputDevice ?? 'keyboard').toUpperCase();
    if (deviceLabel && deviceLabel.textContent !== deviceText) deviceLabel.textContent = deviceText;
    if (phaseStatus) {
      const perfect = Number(merged.perfectPhaseWindow) > 0;
      const phased = Number(merged.phaseTimer) > 0;
      const buffed = Number(merged.autoFireRateBuffTimer) > 0;
      const phaseState = perfect ? 'perfect' : phased ? 'phase' : buffed ? 'buff' : 'ready';
      if (phaseState !== lastPhaseState) {
        const phaseText = perfect ? '完美相位窗口' : phased ? '相位中' : buffed ? '武器涌流' : '相位就绪';
        phaseStatus.textContent = phaseText;
        phaseStatus.dataset.state = phaseState;
        lastPhaseState = phaseState;
      }
    }
    if (merged.objective && missionObjective) {
      const objective = merged.objective;
      const label = String(objective.label ?? objective.type ?? '当前任务');
      const progress = formatObjectiveUnit(objective.progress);
      const target = formatObjectiveUnit(objective.target);
      const text = `${label} · ${progress} / ${target}`;
      if (missionObjective.textContent !== text) missionObjective.textContent = text;
      missionObjective.dataset.state = String(objective.status ?? 'active');
      missionObjective.setAttribute('aria-live', 'off');
      const announcementKey = `${objective.status ?? 'active'}:${Math.floor(clamp01(objective.progressRatio) * 10)}`;
      if (announcementKey !== lastObjectiveAnnouncementKey) {
        const announcement = `当前任务：${label}；进度 ${progress} / ${target}`;
        if (objectiveStatus) objectiveStatus.textContent = announcement;
        missionPanel?.setAttribute('aria-label', announcement);
        lastObjectiveAnnouncementKey = announcementKey;
      }
      missionPanel?.setAttribute('data-objective-type', String(objective.type ?? 'unknown'));
      missionPanel?.setAttribute('data-objective-state', String(objective.status ?? 'active'));
    }
    lastSnapshot = Object.freeze({ ...merged, dashCharges: Object.freeze(charges) });
    renders += 1;
    return true;
  }

  function getDebugSnapshot() {
    return Object.freeze({ disposed, renders, lastSnapshot });
  }

  function renderUpgradeOffer(build, locale = 'zhCN') {
    const view = createUpgradeOfferViewModel(build, locale);
    if (!upgradeOptions || !root?.createElement) return view;
    const buttons = view.cards.map((card) => {
      const button = root.createElement('button');
      button.className = 'upgrade-option';
      button.type = 'button';
      button.dataset.upgradeId = card.id;
      button.setAttribute(
        'aria-label',
        `${card.name}；${card.behavior}；层数 ${card.stackLabel}；标签 ${card.tags.join('、')}；适配初始武器 ${card.starterWeapon}`,
      );
      const number = root.createElement('span');
      number.className = 'upgrade-number';
      number.setAttribute('aria-hidden', 'true');
      number.textContent = String(card.number);
      const title = root.createElement('span');
      title.className = 'upgrade-title';
      title.textContent = card.name;
      const behavior = root.createElement('span');
      behavior.className = 'upgrade-description';
      behavior.textContent = card.behavior;
      const stack = root.createElement('strong');
      stack.className = 'upgrade-effect';
      stack.textContent = `层数 ${card.stackLabel}`;
      const tags = root.createElement('span');
      tags.className = 'upgrade-tags';
      tags.textContent = `${card.tags.join(' · ')} // ${card.compatible ? '适配' : '不适配'} ${card.starterWeapon}`;
      button.append(number, title, behavior, stack, tags);
      return button;
    });
    upgradeOptions.replaceChildren(...buttons);
    return view;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    return true;
  }

  return Object.freeze({ render, renderUpgradeOffer, getDebugSnapshot, dispose });
}
