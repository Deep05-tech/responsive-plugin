export interface OverflowNode {
  selector: string;
  dataId: string | null;
  right: number;
  outerHTML: string;
  type: 'animation' | 'other';
}

export interface SmallTapTarget {
  selector: string;
  width: number;
  height: number;
  outerHTML: string;
}

export interface TapShiftItem {
  selector: string;
  beforeHeight: number;
  afterHeight: number;
}

export interface UnrevealedElement {
  selector: string;
  reason: string;
}

export interface QcPageResult {
  id: number;
  title: string;
  url: string;
  group: 'city_landing_page' | 'library_template' | 'other';
  hasRevealRight: boolean;
  isLibraryTemplate: boolean;
  command: string;

  // 1. Overflow checks
  controlScrollWidth375: number;
  fixedScrollWidth375: number;
  controlScrollWidth768: number;
  fixedScrollWidth768: number;
  overflowPassed: boolean;

  // 2. Cause attribution
  controlOverflowNodesCount: number;
  controlAnimationNodesCount: number;
  controlOtherNodesCount: number;
  controlOtherNodes: OverflowNode[];
  fixedRemainingNodes: OverflowNode[];

  // 3. Animation checks
  animationStatus: 'PASS' | 'FAIL' | 'n/a (no animation)';
  totalRevealElements: number;
  revealedElementsCount: number;
  unrevealedElementsCount: number;
  unrevealedElements: UnrevealedElement[];

  // 4. Tap target checks
  controlSmallTapTargetsCount: number;
  fixedSmallTapTargetsCount: number;
  remainingSmallTapTargets: SmallTapTarget[];
  perElementTapShifts: TapShiftItem[];

  // 5. Desktop regression
  desktopDiffRatio: number; // percentage, e.g. 0.0006%
  desktopDiffPassed: boolean; // desktopDiffRatio <= 0.5%

  // 6. Mobile layout shift
  mobileShiftRatio: number; // percentage
  mobileDiffImagePath?: string;
  mobileBeforeImagePath?: string;
  mobileAfterImagePath?: string;

  // 7. Console errors
  consoleErrorsControl: string[];
  consoleErrorsFixed: string[];
  newConsoleErrors: string[];

  // Status
  status: 'PASS' | 'review_layout' | 'needs_human' | 'error';
  statusReason?: string;
  timestamp: string;
}

export interface QcSummaryGroupStats {
  total: number;
  pass: number;
  review_layout: number;
  needs_human: number;
  error: number;
}

export interface QcSummary {
  totalPages: number;
  passCount: number;
  reviewLayoutCount: number;
  needsHumanCount: number;
  errorCount: number;
  byGroup: {
    city_landing_page: QcSummaryGroupStats;
    library_template: QcSummaryGroupStats;
    other: QcSummaryGroupStats;
  };
  warningOtherPages?: string;
}

export interface QcOptions {
  limit?: number;
  all?: boolean;
  cssPath?: string;
  outputDir?: string;
  force?: boolean;
}
