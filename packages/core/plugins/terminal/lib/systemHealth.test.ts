import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatteryOutput, parseVmStat, formatUptime } from './systemHealth.js';

describe('systemHealth', () => {
  describe('parseBatteryOutput', () => {
    it('parses discharging battery', () => {
      const sample = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=6488163)\t88%; discharging; 6:47 remaining present: true`;
      const res = parseBatteryOutput(sample);
      assert.equal(res.hasBattery, true);
      assert.equal(res.source, 'Battery Power');
      assert.equal(res.percent, 88);
      assert.equal(res.chargingState, 'discharging');
      assert.equal(res.timeRemaining, '6:47 còn lại');
    });

    it('parses charging battery on AC', () => {
      const sample = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=6488163)\t45%; charging; 1:15 remaining present: true`;
      const res = parseBatteryOutput(sample);
      assert.equal(res.hasBattery, true);
      assert.equal(res.source, 'AC Power');
      assert.equal(res.percent, 45);
      assert.equal(res.chargingState, 'charging');
      assert.equal(res.timeRemaining, '1:15 còn lại');
    });

    it('handles AC Power without internal battery (e.g. Mac mini / Studio)', () => {
      const sample = `Now drawing from 'AC Power'\n`;
      const res = parseBatteryOutput(sample);
      assert.equal(res.hasBattery, false);
      assert.equal(res.source, 'AC Power');
      assert.equal(res.percent, 100);
      assert.equal(res.chargingState, 'unknown');
    });
  });

  describe('parseVmStat', () => {
    it('parses vm_stat numbers correctly', () => {
      const sample = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                4228.
Pages active:                            247859.
Pages inactive:                          246509.
Pages speculative:                          684.
Pages throttled:                              0.
Pages wired down:                        105917.
Pages occupied by compressor:            406616.`;

      const totalMem = 16 * 1024 * 1024 * 1024; // 16 GB
      const res = parseVmStat(sample, totalMem);

      assert.equal(res.totalGB, 16);
      // active (247859) + wired (105917) + compressor (406616) = 760392 pages * 16384 = ~12.45 GB
      assert.ok(res.usedGB > 11 && res.usedGB < 14);
      assert.ok(res.percent > 70 && res.percent < 90);
    });
  });

  describe('formatUptime', () => {
    it('formats days and hours', () => {
      assert.equal(formatUptime(86400 * 3 + 3600 * 4), '3d 4h');
    });

    it('formats hours and minutes', () => {
      assert.equal(formatUptime(3600 * 5 + 60 * 20), '5h 20m');
    });

    it('formats minutes', () => {
      assert.equal(formatUptime(60 * 42), '42m');
    });
  });
});
