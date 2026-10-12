export interface OverflowingNodeDetail {
  selector: string;
  dataId: string | null;
  className: string;
  right: number;
  computedTransform: string;
  position: string;
  outerHTML: string;
}

export interface DeviceTimingMeasurement {
  scrollWidth: number;
  bodyScrollWidth: number;
  innerWidth: number;
  visualViewportWidth: number;
  visualViewportScale: number;
  scrollX: number;
  htmlOverflowX: string;
  bodyOverflowX: string;
  overflowingNodes: OverflowingNodeDetail[];
}

export interface DeviceResult {
  device: string;
  isMobile: boolean;
  hasTouch: boolean;
  beforeScroll: DeviceTimingMeasurement;
  afterScroll: DeviceTimingMeasurement;
  after5s: DeviceTimingMeasurement;
  pass: boolean;
}

export interface LiveQcPageResult {
  id: number;
  title: string;
  url: string;
  cacheBustedUrl: string;

  // Cache test
  cacheHeaders: {
    cacheControl?: string;
    xCache?: string;
    xLiteSpeedCache?: string;
    cfCacheStatus?: string;
    server?: string;
  };
  cacheBustedDiff: boolean;

  // Fix verification
  fixIsLive: boolean;
  hasFixRule: boolean;
  htmlOverflowX: string;
  firstRevealTransform: string;
  elementorCssUrl: string | null;
  elementorCssVer: string | null;

  // Device measurements
  devices: Record<string, DeviceResult>;

  // Desktop regression & noise floor
  desktopNoiseFloor: number;
  desktopDiffRatio: number;
  desktopDiffPassed: boolean;

  // Overall page status
  status: 'PASS' | 'FIX_NOT_LIVE' | 'OTHER_OVERFLOW' | 'DEVICE_ONLY' | 'CACHE_MISMATCH';
  statusReason?: string;
  overflowingNodesList: OverflowingNodeDetail[];
  timestamp: string;
}

export interface LiveQcSummary {
  totalPages: number;
  passCount: number;
  fixNotLiveCount: number;
  otherOverflowCount: number;
  deviceOnlyCount: number;
  cacheMismatchCount: number;
  devicesAudited: string[];
}

export interface LiveQcOptions {
  limit?: number;
  all?: boolean;
  outputDir?: string;
  force?: boolean;
}
