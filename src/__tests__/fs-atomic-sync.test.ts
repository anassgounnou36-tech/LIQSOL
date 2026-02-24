import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../shared/fs.js';

const TEST_DIR = path.join(process.cwd(), 'data');
const TEST_FILE_PATH = path.join(TEST_DIR, 'atomic-sync-test.json');
const TEST_TMP_PATH = path.join(TEST_DIR, `${path.basename(TEST_FILE_PATH)}.tmp`);

describe('writeJsonAtomicSync', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_FILE_PATH)) fs.unlinkSync(TEST_FILE_PATH);
    if (fs.existsSync(TEST_TMP_PATH)) fs.unlinkSync(TEST_TMP_PATH);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_FILE_PATH)) fs.unlinkSync(TEST_FILE_PATH);
    if (fs.existsSync(TEST_TMP_PATH)) fs.unlinkSync(TEST_TMP_PATH);
  });

  it('writes valid JSON atomically and leaves no tmp file behind', () => {
    const payload = {
      items: Array.from({ length: 250 }, (_, i) => ({ id: i, key: `k-${i}`, value: `v-${i}` })),
    };

    writeJsonAtomicSync(TEST_FILE_PATH, payload);

    expect(fs.existsSync(TEST_FILE_PATH)).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(TEST_FILE_PATH, 'utf8'))).not.toThrow();
    expect(fs.existsSync(TEST_TMP_PATH)).toBe(false);
  });
});
