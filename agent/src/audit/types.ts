export type IssueType =
  | 'horizontal_overflow'
  | 'overflowing_element'
  | 'multi_cause_overflow'
  | 'animation_overflow'
  | 'small_font_size'
  | 'small_tap_target'
  | 'overlapping_elements'
  | 'layout_collision'
  | 'image_wider_than_container'
  | 'fixed_pixel_width_overflow'
  | 'container_bleed'
  | 'scroll_truncation'
  | 'scroll_trap'
  | 'margin_collapse_void';

export type SeverityTier = 'P0' | 'P1' | 'P2';

export type IssueScope = 'elementor' | 'theme' | 'wpadminbar' | 'unmapped';

export type UnpatchableReason = 'theme_scope' | 'not_in_elementor_data' | 'inline_html_style';

export type FontSource = 'inline' | 'stylesheet' | 'elementor_setting';

export interface Issue {
  type: IssueType;
  severity: SeverityTier;
  elementId: string | null;
  scope?: IssueScope;
  selector: string;
  viewport: 'mobile' | 'tablet' | 'desktop' | string;
  message: string;
  details: Record<string, any>;
  patchable?: boolean;
  unpatchableReason?: UnpatchableReason;
  fontSource?: FontSource;
  outerHtmlSnippet?: string;
  confirmedByRemoval?: boolean;
}

export interface ViewportAuditResult {
  viewport: 'mobile' | 'tablet' | 'desktop' | string;
  width: number;
  height: number;
  screenshotPath: string;
  hasHorizontalOverflow: boolean;
  scrollWidth: number;
  innerWidth: number;
  issues: Issue[];
  canScrollToBottom?: boolean;
  maxScrollY?: number;
  finalScrollY?: number;
  footerVisibleAtBottom?: boolean;
  isScrollTrapped?: boolean;
}

export interface ElementIssuesGroup {
  elementId: string | null;
  scope?: IssueScope;
  total: number;
  rootCauses: Record<string, Issue[]>;
  issues: Issue[];
}

export interface AuditSummary {
  totalIssues: number;
  bySeverity: {
    P0: number;
    P1: number;
    P2: number;
  };
  byScope: {
    elementor: number;
    theme: number;
    wpadminbar: number;
    unmapped: number;
  };
  patchableCount: number;
  unpatchableCount: number;
  distinctElements: number;
}

export interface AuditReport {
  pageId: string | number;
  pageUrl: string;
  timestamp: string;
  viewports: {
    mobile: ViewportAuditResult;
    tablet: ViewportAuditResult;
    desktop: ViewportAuditResult;
    [key: string]: ViewportAuditResult;
  };
  totalIssues: number;
  summary: AuditSummary;
  severityCounts: {
    P0: number;
    P1: number;
    P2: number;
  };
  issuesByElementId: Record<string, ElementIssuesGroup>;
  issuesByRootCause: Record<string, Issue[]>;
}

