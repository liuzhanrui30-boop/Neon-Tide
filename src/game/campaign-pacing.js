const COMPLETION_SHARE = Object.freeze({
  purge: 0.84,
  anchors: 0.84,
  'moving-zone': 0.84,
  escort: 0.84,
  'elite-hunt': 0.84,
  'storm-corridor': 0.86,
  'core-harvest': 0.82,
  'dual-crisis': 0.84,
});

// These are transparent analytical baselines, not runtime timers. Combat rooms
// complete as soon as their real targets are destroyed; the rates only convert
// the authored duration budget into verifiable amounts of combat work.
export const CAMPAIGN_STANDARD_THROUGHPUT = Object.freeze({
  purgeKillsPerSecond: 0.42,
  eliteDamagePerSecond: 0.45,
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = (value, fallback) => {
  const number = finite(value, fallback);
  return number > 0 ? number : fallback;
};

function pacingContract(type, authoredTargetDurationSeconds, effectiveTargetDurationSeconds, workSeconds) {
  return Object.freeze({
    type,
    authoredTargetDurationSeconds,
    effectiveTargetDurationSeconds,
    objectiveWorkSeconds: workSeconds,
    completesOnObjective: true,
  });
}

export function tuneCampaignObjectiveTemplate(template, {
  targetDurationSeconds,
  durationScale = 1,
} = {}) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new TypeError('campaign pacing requires an objective template');
  }
  if (!Object.hasOwn(COMPLETION_SHARE, template.type)) {
    throw new TypeError(`campaign pacing does not support objective type: ${String(template.type)}`);
  }
  if (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds <= 0) {
    throw new TypeError('campaign target duration must be positive and finite');
  }
  if (!Number.isFinite(durationScale) || durationScale <= 0 || durationScale > 1) {
    throw new TypeError('campaign durationScale must be in (0, 1]');
  }

  const effectiveTargetDurationSeconds = targetDurationSeconds * durationScale;
  const workSeconds = effectiveTargetDurationSeconds * COMPLETION_SHARE[template.type];
  const tuned = {
    ...template,
    timeout: effectiveTargetDurationSeconds,
    campaignPacing: pacingContract(
      template.type,
      targetDurationSeconds,
      effectiveTargetDurationSeconds,
      workSeconds,
    ),
  };

  if (template.type === 'purge') {
    tuned.killTarget = Math.max(1, Math.round(workSeconds * CAMPAIGN_STANDARD_THROUGHPUT.purgeKillsPerSecond));
  } else if (template.type === 'anchors') {
    const count = Math.max(2, Math.min(4, Math.trunc(positive(template.anchorCount, 3))));
    tuned.anchorCount = count;
    tuned.anchorSeconds = workSeconds / count;
  } else if (template.type === 'moving-zone') {
    tuned.holdSeconds = workSeconds;
  } else if (template.type === 'escort') {
    tuned.escortSpeed = positive(template.escortSpeed, 2.4);
    tuned.escortDistance = tuned.escortSpeed * workSeconds;
  } else if (template.type === 'elite-hunt') {
    const count = Math.max(1, Math.trunc(positive(template.eliteTarget, 2)));
    tuned.eliteTarget = count;
    tuned.eliteTargetHp = workSeconds * CAMPAIGN_STANDARD_THROUGHPUT.eliteDamagePerSecond / count;
  } else if (template.type === 'storm-corridor') {
    tuned.survivalSeconds = workSeconds;
  } else if (template.type === 'core-harvest') {
    const count = Math.max(9, Math.trunc(positive(template.coreCount, 5)));
    const activationDelay = Math.min(workSeconds * 0.2, positive(template.activationDelay, 2) * durationScale);
    tuned.coreCount = count;
    tuned.activationDelay = activationDelay;
    tuned.coreActivationIntervalSeconds = count > 1 ? (workSeconds - activationDelay) / (count - 1) : 0;
  } else if (template.type === 'dual-crisis') {
    const count = 2;
    tuned.crisisSeconds = workSeconds / count;
    tuned.escalationSeconds = Math.max(tuned.crisisSeconds, effectiveTargetDurationSeconds * 0.72);
  }

  return Object.freeze(tuned);
}

export function estimateCampaignObjectiveSeconds(template) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new TypeError('campaign objective estimate requires a template');
  }
  if (template.type === 'purge') {
    return positive(template.killTarget ?? template.target, 1)
      / CAMPAIGN_STANDARD_THROUGHPUT.purgeKillsPerSecond;
  }
  if (template.type === 'anchors') {
    if (Array.isArray(template.anchors)) {
      return template.anchors.reduce((total, anchor) => total + positive(anchor.requiredSeconds, 1.4), 0);
    }
    return positive(template.anchorCount, 3) * positive(template.anchorSeconds, 1.4);
  }
  if (template.type === 'moving-zone') return positive(template.holdSeconds ?? template.target, 12);
  if (template.type === 'escort') {
    return positive(template.escortDistance ?? template.target, 24)
      / positive(template.escortSpeed ?? template.escort?.speed, 2.4);
  }
  if (template.type === 'elite-hunt') {
    const totalHp = Array.isArray(template.eliteTargets)
      ? template.eliteTargets.reduce((total, target) => total + positive(target.hp, 6), 0)
      : positive(template.eliteTarget, 2) * positive(template.eliteTargetHp, 6);
    return totalHp / CAMPAIGN_STANDARD_THROUGHPUT.eliteDamagePerSecond;
  }
  if (template.type === 'storm-corridor') return positive(template.survivalSeconds ?? template.target, 18);
  if (template.type === 'core-harvest') {
    if (Array.isArray(template.cores)) {
      return Math.max(...template.cores.map((core) => positive(core.activationAt, template.activationDelay)));
    }
    const count = Math.max(2, Math.trunc(positive(template.coreCount, 5)));
    return positive(template.activationDelay, 0.75)
      + Math.max(0, count - 1) * positive(template.coreActivationIntervalSeconds, 0.01);
  }
  if (template.type === 'dual-crisis') {
    if (Array.isArray(template.crises)) {
      return template.crises.reduce((total, crisis) => total + positive(crisis.requiredSeconds, 3.2), 0);
    }
    return 2 * positive(template.crisisSeconds, 3.2);
  }
  throw new TypeError(`campaign objective estimate does not support type: ${String(template.type)}`);
}
