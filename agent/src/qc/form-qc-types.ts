export interface FormAncestorDetail {
  tag: string;
  className: string;
  opacity: string;
  display: string;
  visibility: string;
  transform: string;
  height: string;
  overflow: string;
  hasReveal: boolean;
  hasInView: boolean;
  hidesElement: boolean;
  hideReason?: string;
}

export interface FormElementDetail {
  selector: string;
  role: 'hero_card' | 'hero_form' | 'bottom_cta_card' | 'bottom_cta_form' | 'other_form';
  boundingRect: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  };
  insideViewportAtBottom: boolean;
  computedOpacity: string;
  computedDisplay: string;
  computedVisibility: string;
  computedTransform: string;
  computedHeight: string;
  computedOverflow: string;
  hasRevealClass: boolean;
  hasInViewClass: boolean;
  firstHidingAncestor: string | null;
  ancestorChain: FormAncestorDetail[];
  screenshotBase64?: string;
  status: 'FORM_VISIBLE' | 'FORM_STUCK_HIDDEN' | 'FORM_NOT_RENDERED' | 'FORM_CLIPPED' | 'SCRIPT_ERROR';
  statusReason: string;
}

export interface FormDeviceResult {
  device: string;
  isMobile: boolean;
  hasTouch: boolean;
  scrollHeight: number;
  finalScrollY: number;
  forms: FormElementDetail[];
  formStatus: 'FORM_VISIBLE' | 'FORM_STUCK_HIDDEN' | 'FORM_NOT_RENDERED' | 'FORM_CLIPPED' | 'SCRIPT_ERROR';
  hiddenByElement: string | null;
  viewportScreenshotBase64?: string;
  revealScriptRan: boolean;
  revealInViewCount: number;
  jsErrors: string[];
  failedRequests: Array<{ url: string; status?: number; error?: string }>;
  scrollWidth: number;
  innerWidth: number;
  visualViewportWidth: number;
  scrollX: number;
  firstRevealTransformBeforeScroll: string;
  htmlOverflowX: string;
  hasFixRule: boolean;
  hScrollStatus: 'PASS' | 'FIX_NOT_LIVE' | 'OTHER_OVERFLOW';
}

export interface FormQcPageResult {
  id: number;
  title: string;
  url: string;
  responseHeaders: Record<string, string>;
  optimizationMarkers: string[];
  devices: Record<string, FormDeviceResult>;
  overallFormStatus: 'FORM_VISIBLE' | 'FORM_STUCK_HIDDEN' | 'FORM_NOT_RENDERED' | 'FORM_CLIPPED' | 'SCRIPT_ERROR';
  overallHScrollStatus: 'PASS' | 'FIX_NOT_LIVE' | 'OTHER_OVERFLOW';
  timestamp: string;
}

export interface FormQcSummary {
  totalPages: number;
  formStatusCounts: {
    FORM_VISIBLE: number;
    FORM_STUCK_HIDDEN: number;
    FORM_NOT_RENDERED: number;
    FORM_CLIPPED: number;
    SCRIPT_ERROR: number;
  };
  hScrollStatusCounts: {
    PASS: number;
    FIX_NOT_LIVE: number;
    OTHER_OVERFLOW: number;
  };
  devicesAudited: string[];
}
