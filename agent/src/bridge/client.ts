import { EraConfig, loadConfig } from '../config/index.js';
import { PatchItem } from '../patch/validator.js';

export interface WpPageSummary {
  id: number;
  title: string;
  url: string;
  modified: string;
  status: string;
  post_type?: string;
  template_type?: string;
}

export interface WpPageDetail {
  id: number;
  title: string;
  url: string;
  modified: string;
  _elementor_data: any[];
  post_type?: string;
  template_type?: string;
}

export interface PatchResponse {
  success: boolean;
  page_id: number;
  backup_key: string;
  applied_diff: Array<{
    element_id: string;
    before: Record<string, any>;
    after: Record<string, any>;
  }>;
  patched_at: string;
}

export interface RestoreResponse {
  success: boolean;
  page_id: number;
  restored_key: string;
  restored_at: string;
}

export class EraBridgeClient {
  private config: EraConfig;

  constructor(config?: EraConfig) {
    this.config = config || loadConfig();
  }

  private getAuthHeaders(): Record<string, string> {
    const credentials = Buffer.from(
      `${this.config.wpUser}:${this.config.wpAppPassword.replace(/\s+/g, '')}`
    ).toString('base64');

    return {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /**
   * Fetch all Elementor-enabled pages from WordPress bridge.
   */
  public async getPages(): Promise<WpPageSummary[]> {
    const url = `${this.config.wpBaseUrl.replace(/\/$/, '')}/wp-json/era/v1/pages`;
    const res = await fetch(url, {
      method: 'GET',
      headers: this.getAuthHeaders(),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to fetch pages from WP Bridge (${res.status}): ${errorText}`);
    }

    return res.json() as Promise<WpPageSummary[]>;
  }

  /**
   * Fetch single Elementor page details & JSON data.
   */
  public async getPage(id: number | string): Promise<WpPageDetail> {
    const url = `${this.config.wpBaseUrl.replace(/\/$/, '')}/wp-json/era/v1/page/${id}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: this.getAuthHeaders(),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to fetch page ${id} from WP Bridge (${res.status}): ${errorText}`);
    }

    return res.json() as Promise<WpPageDetail>;
  }

  /**
   * Apply responsive setting patches to a page.
   */
  public async patchPage(
    id: number | string,
    patches: PatchItem[],
    allowHiding: boolean = false
  ): Promise<PatchResponse> {
    const url = `${this.config.wpBaseUrl.replace(/\/$/, '')}/wp-json/era/v1/page/${id}/patch`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({
        patches,
        allow_hiding: allowHiding,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to apply patch on page ${id} (${res.status}): ${errorText}`);
    }

    return res.json() as Promise<PatchResponse>;
  }

  /**
   * Restore a page from a timestamped backup.
   */
  public async restorePage(id: number | string, backupKey?: string): Promise<RestoreResponse> {
    const url = `${this.config.wpBaseUrl.replace(/\/$/, '')}/wp-json/era/v1/page/${id}/restore`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({
        backup_key: backupKey,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to restore page ${id} (${res.status}): ${errorText}`);
    }

    return res.json() as Promise<RestoreResponse>;
  }

  /**
   * Get list of backups for a page.
   */
  public async getBackups(id: number | string): Promise<any[]> {
    const url = `${this.config.wpBaseUrl.replace(/\/$/, '')}/wp-json/era/v1/page/${id}/backups`;
    const res = await fetch(url, {
      method: 'GET',
      headers: this.getAuthHeaders(),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to get backups for page ${id} (${res.status}): ${errorText}`);
    }

    return res.json();
  }
}
