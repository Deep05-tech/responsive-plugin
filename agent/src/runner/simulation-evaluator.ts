export interface SimulationVerdictInput {
  baseMobileP0: number;
  simMobileP0: number;
  baseTabletP0: number;
  simTabletP0: number;
  baseDesktopP0: number;
  simDesktopP0: number;
  baseMobileScrollWidth: number;
  simMobileScrollWidth: number;
  baseTabletScrollWidth: number;
  simTabletScrollWidth: number;
  baseIssues: Array<{ elementId?: string; type: string }>;
  simIssues: Array<{ elementId?: string; type: string }>;
  desktopDiffPassed: boolean;
  desktopMismatchRatio: number;
  desktopThreshold: number;
}

export interface SimulationVerdictResult {
  verdict: 'VALIDATED' | 'PARTIAL' | 'FAILED';
  passed: boolean;
  reasons: string[];
  p0DropMobilePercent: number;
  p0DropTabletPercent: number;
  scrollWidthMobilePassed: boolean;
  scrollWidthTabletPassed: boolean;
  noNewIssues: boolean;
  desktopPassed: boolean;
}

export function evaluateSimulationVerdict(input: SimulationVerdictInput): SimulationVerdictResult {
  const reasons: string[] = [];

  // 1. P0 drop on mobile (0 or at least 80% lower than baseline)
  const mobileP0Dropped80 =
    input.simMobileP0 === 0 ||
    (input.baseMobileP0 > 0 && (input.baseMobileP0 - input.simMobileP0) / input.baseMobileP0 >= 0.8);
  const p0DropMobilePercent =
    input.baseMobileP0 === 0
      ? input.simMobileP0 === 0
        ? 100
        : 0
      : Math.max(0, ((input.baseMobileP0 - input.simMobileP0) / input.baseMobileP0) * 100);

  // 2. P0 drop on tablet (0 or at least 80% lower than baseline)
  const tabletP0Dropped80 =
    input.simTabletP0 === 0 ||
    (input.baseTabletP0 > 0 && (input.baseTabletP0 - input.simTabletP0) / input.baseTabletP0 >= 0.8);
  const p0DropTabletPercent =
    input.baseTabletP0 === 0
      ? input.simTabletP0 === 0
        ? 100
        : 0
      : Math.max(0, ((input.baseTabletP0 - input.simTabletP0) / input.baseTabletP0) * 100);

  // 3. scrollWidth <= innerWidth
  const scrollWidthMobilePassed = input.simMobileScrollWidth <= 375;
  const scrollWidthTabletPassed = input.simTabletScrollWidth <= 768;

  // 4. No new issues appeared (compare by elementId + type)
  const baseIssueKeys = new Set(input.baseIssues.map((i) => `${i.elementId || 'unknown'}::${i.type}`));
  const newIssues = input.simIssues.filter((i) => !baseIssueKeys.has(`${i.elementId || 'unknown'}::${i.type}`));
  const noNewIssues = newIssues.length === 0;

  // 5. Desktop diff
  const desktopPassed = input.desktopDiffPassed;

  // 6. Zero Element Collision / Overlap Invariant
  const collisionIssues = input.simIssues.filter(
    (i) => i.type === 'overlapping_elements' || i.type === 'layout_collision'
  );
  const noCollisions = collisionIssues.length === 0;

  // 7. Zero Container Bleed, Scroll Truncation & Scroll Trap Invariant
  const verticalBreachIssues = input.simIssues.filter(
    (i) => i.type === 'container_bleed' || i.type === 'scroll_truncation' || i.type === 'scroll_trap'
  );
  const noVerticalBreaches = verticalBreachIssues.length === 0;

  const totalBaseP0 = input.baseMobileP0 + input.baseTabletP0 + input.baseDesktopP0;
  const totalSimP0 = input.simMobileP0 + input.simTabletP0 + input.simDesktopP0;
  const anyP0Drop = totalSimP0 < totalBaseP0;

  const isValidated =
    mobileP0Dropped80 &&
    tabletP0Dropped80 &&
    scrollWidthMobilePassed &&
    scrollWidthTabletPassed &&
    noNewIssues &&
    desktopPassed &&
    noCollisions &&
    noVerticalBreaches;

  let verdict: 'VALIDATED' | 'PARTIAL' | 'FAILED' = 'FAILED';
  if (isValidated) {
    verdict = 'VALIDATED';
  } else if (anyP0Drop) {
    verdict = 'PARTIAL';
  } else {
    verdict = 'FAILED';
  }

  if (!mobileP0Dropped80) {
    reasons.push(
      `Mobile P0 drop is ${p0DropMobilePercent.toFixed(1)}% (requires >= 80% or 0 remaining; had ${input.baseMobileP0} -> ${input.simMobileP0})`
    );
  }
  if (!tabletP0Dropped80) {
    reasons.push(
      `Tablet P0 drop is ${p0DropTabletPercent.toFixed(1)}% (requires >= 80% or 0 remaining; had ${input.baseTabletP0} -> ${input.simTabletP0})`
    );
  }
  if (!scrollWidthMobilePassed) {
    reasons.push(`Mobile scrollWidth is ${input.simMobileScrollWidth}px (must be <= 375px)`);
  }
  if (!scrollWidthTabletPassed) {
    reasons.push(`Tablet scrollWidth is ${input.simTabletScrollWidth}px (must be <= 768px)`);
  }
  if (!noNewIssues) {
    reasons.push(`${newIssues.length} new issue(s) appeared during simulation`);
  }
  if (!desktopPassed) {
    reasons.push(
      `Desktop visual regression mismatch ${(input.desktopMismatchRatio * 100).toFixed(4)}% exceeds threshold ${(input.desktopThreshold * 100).toFixed(4)}%`
    );
  }
  if (!noCollisions) {
    reasons.push(
      `${collisionIssues.length} element collision/overlap defect(s) detected in simulated layout (elements smashed together)`
    );
  }
  if (!noVerticalBreaches) {
    reasons.push(
      `Vertical layout breach detected: ${verticalBreachIssues.length} container bleed or scroll truncation issue(s) remaining.`
    );
  }

  return {
    verdict,
    passed: isValidated,
    reasons,
    p0DropMobilePercent,
    p0DropTabletPercent,
    scrollWidthMobilePassed,
    scrollWidthTabletPassed,
    noNewIssues,
    desktopPassed,
  };
}
