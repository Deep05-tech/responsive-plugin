import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root or agent directory
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface ViewportConfig {
  name: 'mobile' | 'tablet' | 'desktop' | 'tablet_pro' | 'surface_pro' | string;
  width: number;
  height: number;
}

export const VIEWPORTS: ViewportConfig[] = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

export const EXTENDED_VIEWPORTS: ViewportConfig[] = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet_pro', width: 1032, height: 1376 },
  { name: 'surface_pro', width: 960, height: 1440 },
];

export interface EraConfig {
  wpBaseUrl: string;
  wpUser: string;
  wpAppPassword: string;
  stagingBasicAuthUser?: string;
  stagingBasicAuthPass?: string;
  openaiApiKey: string;
  openaiModel: string;
  productionBlocklist: string[];
  allowHiding: boolean;
  maxIterations: number;
  maxLlmCallsPerRun: number;
  desktopDiffThreshold: number;
  diffIgnoreSelectors: string[];
  outputDir: string;
  offline?: boolean;
  includeTypography?: boolean;
}

export function loadConfig(): EraConfig {
  const blocklistRaw = process.env.PRODUCTION_URL_BLOCKLIST || '';
  const productionBlocklist = blocklistRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const diffIgnoreRaw = process.env.DIFF_IGNORE_SELECTORS || '';
  const diffIgnoreSelectors = diffIgnoreRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    wpBaseUrl: process.env.WP_BASE_URL || 'http://localhost:8000',
    wpUser: process.env.WP_USER || '',
    wpAppPassword: process.env.WP_APP_PASSWORD || '',
    stagingBasicAuthUser: process.env.STAGING_BASIC_AUTH_USER || '',
    stagingBasicAuthPass: process.env.STAGING_BASIC_AUTH_PASS || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
    productionBlocklist,
    allowHiding: process.env.ALLOW_HIDING === 'true',
    maxIterations: parseInt(process.env.MAX_ITERATIONS || '3', 10),
    maxLlmCallsPerRun: parseInt(process.env.MAX_LLM_CALLS_PER_RUN || '30', 10),
    desktopDiffThreshold: parseFloat(process.env.DESKTOP_DIFF_THRESHOLD || '0.005'),
    diffIgnoreSelectors,
    outputDir: path.resolve(process.cwd(), 'output'),
    offline: process.env.ERA_OFFLINE === 'true',
    includeTypography: process.env.INCLUDE_TYPOGRAPHY === 'true',
  };
}

/**
 * Hard Rule 3: Refuse to run if target URL matches a blocklisted production domain/URL.
 */
export function checkProductionBlocklist(targetUrl: string, blocklist: string[]): void {
  try {
    const parsedTarget = new URL(targetUrl);
    const targetHost = parsedTarget.hostname.toLowerCase();

    for (const item of blocklist) {
      if (!item) continue;
      const cleanItem = item.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
      if (targetHost === cleanItem || targetHost.endsWith('.' + cleanItem) || targetUrl.toLowerCase().includes(item)) {
        throw new Error(
          `[CRITICAL SAFETY BLOCK] Target URL "${targetUrl}" matches production blocklist item "${item}". Execution aborted.`
        );
      }
    }
  } catch (err: any) {
    if (err.message.includes('[CRITICAL SAFETY BLOCK]')) {
      throw err;
    }
    for (const item of blocklist) {
      if (item && targetUrl.toLowerCase().includes(item.toLowerCase())) {
        throw new Error(
          `[CRITICAL SAFETY BLOCK] Target "${targetUrl}" matches production blocklist item "${item}". Execution aborted.`
        );
      }
    }
  }
}
