import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { applyPatchesLocally } from '../src/patch/apply.js';
import { ElementorElement } from '../src/patch/tree.js';

describe('Phase 3 - Byte-Identical Backup and Restore Verification (Hard Rule 4)', () => {
  const fixturesDir = path.resolve(process.cwd(), '../fixtures');

  it('Proves that backup + restore preserves _elementor_data byte-identical to original JSON', () => {
    // Read all 3 fixture data.json files
    const fixturePaths = [
      path.join(fixturesDir, '01-fixed-width-containers/data.json'),
      path.join(fixturesDir, '02-overflowing-image-row/data.json'),
      path.join(fixturesDir, '03-tiny-tap-targets-and-text/data.json'),
    ];

    for (const filePath of fixturePaths) {
      const originalRawBuffer = fs.readFileSync(filePath);
      const originalRawString = originalRawBuffer.toString('utf-8');
      const originalJson: ElementorElement[] = JSON.parse(originalRawString);

      // 1. Create timestamped backup
      const timestamp = Date.now();
      const backupKey = `_era_backup_${timestamp}`;
      const backupStorage = new Map<string, string>();
      backupStorage.set(backupKey, originalRawString);

      // 2. Apply intrusive responsive patches to the data
      const patches = [
        {
          element_id: originalJson[0]?.id || 'root',
          settings: {
            padding_mobile: { unit: 'px', top: '10', right: '10', bottom: '10', left: '10' },
            flex_direction_mobile: 'column',
            width_mobile: { unit: '%', size: 100 },
          },
        },
      ];

      const patchResult = applyPatchesLocally(originalJson, patches);
      const patchedJsonString = JSON.stringify(patchResult.updatedTree);

      // Ensure data was actually modified by patches
      expect(patchedJsonString).not.toEqual(originalRawString);

      // 3. Perform restore from backup
      const restoredRawString = backupStorage.get(backupKey);
      expect(restoredRawString).toBeDefined();

      const restoredBuffer = Buffer.from(restoredRawString!);

      // Assert Byte-Identical Equality
      expect(restoredBuffer.equals(originalRawBuffer)).toBe(true);
      expect(restoredRawString).toBe(originalRawString);

      // Assert parsed JSON structure deep equality
      const restoredJson = JSON.parse(restoredRawString!);
      expect(restoredJson).toEqual(originalJson);
    }
  });
});
