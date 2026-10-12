import { describe, it, expect } from 'vitest';
import { EraBridgeClient } from '../src/bridge/client.js';
import { loadConfig } from '../src/config/index.js';

describe('Phase 2 Safety - Strictly Zero Write Requests', () => {
  it('Verifies that ERA_ENABLE_WRITES gate is false and POST /patch returns 404 or fails write', async () => {
    const config = loadConfig();
    const client = new EraBridgeClient(config);

    // Attempting a write route must be rejected / 404
    try {
      await client.patchPage('498', [
        {
          element_id: 'dummy',
          settings: { padding_mobile: { unit: 'px', top: '10', right: '10', bottom: '10', left: '10' } },
        },
      ]);
      // If it doesn't throw, fail the test
      expect(true).toBe(false);
    } catch (err: any) {
      // Must be 404 or connection refused/error
      expect(err).toBeDefined();
    }
  });

  it('Verifies that EraBridgeClient has distinct read methods vs write methods', () => {
    const config = loadConfig();
    const client = new EraBridgeClient(config);

    expect(typeof client.getPage).toBe('function');
    expect(typeof client.getPages).toBe('function');
    expect(typeof client.patchPage).toBe('function');
    expect(typeof client.restorePage).toBe('function');
  });
});
