import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';
import { isTunnelActive } from './silenceMonitor.js';

const execFileAsync = promisify(execFile);

export interface SystemHealth {
  battery: {
    hasBattery: boolean;
    source: 'AC Power' | 'Battery Power' | 'Unknown';
    percent: number;
    chargingState: 'charging' | 'discharging' | 'charged' | 'ac attached' | 'unknown';
    timeRemaining: string;
  };
  memory: {
    totalGB: number;
    usedGB: number;
    freeGB: number;
    percent: number;
  };
  cpu: {
    cores: number;
    loadAvg: [number, number, number];
    percent: number;
  };
  uptime: number;
  uptimeFormatted: string;
  tunnelActive: boolean;
}

/**
 * Parse macOS `pmset -g batt` output into structured battery telemetry.
 */
export function parseBatteryOutput(stdout: string): SystemHealth['battery'] {
  const sourceMatch = stdout.match(/Now drawing from '(.*?)'/);
  const source = (sourceMatch?.[1] as 'AC Power' | 'Battery Power') || 'Unknown';

  const percentMatch = stdout.match(/(\d+)%/);
  const percent = percentMatch ? parseInt(percentMatch[1], 10) : 100;

  let chargingState: SystemHealth['battery']['chargingState'] = 'unknown';
  if (/discharging/i.test(stdout)) {
    chargingState = 'discharging';
  } else if (/charging/i.test(stdout)) {
    chargingState = 'charging';
  } else if (/charged/i.test(stdout)) {
    chargingState = 'charged';
  } else if (/AC attached/i.test(stdout)) {
    chargingState = 'ac attached';
  }

  // Extract remaining time if present (e.g., "6:47 remaining", "0:00 remaining")
  const timeMatch = stdout.match(/(\d+:\d+)\s+remaining/i);
  const timeRemaining = timeMatch ? `${timeMatch[1]} còn lại` : '';

  const hasBattery = Boolean(percentMatch) || /InternalBattery/i.test(stdout);

  return {
    hasBattery,
    source,
    percent,
    chargingState,
    timeRemaining,
  };
}

/**
 * Parse macOS `vm_stat` output into used/total memory stats.
 */
export function parseVmStat(
  stdout: string,
  totalMemBytes: number = os.totalmem(),
): SystemHealth['memory'] {
  try {
    const pageSizeMatch = stdout.match(/page size of (\d+) bytes/i);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

    const extractPages = (pattern: RegExp): number => {
      const match = stdout.match(pattern);
      return match ? parseInt(match[1], 10) : 0;
    };

    const active = extractPages(/Pages active:\s+(\d+)/);
    const wired = extractPages(/Pages wired down:\s+(\d+)/);
    const compressor = extractPages(/Pages occupied by compressor:\s+(\d+)/);
    const free = extractPages(/Pages free:\s+(\d+)/);
    const speculative = extractPages(/Pages speculative:\s+(\d+)/);

    const usedBytes = (active + wired + compressor) * pageSize;
    const freeBytes = (free + speculative) * pageSize;

    const totalGB = parseFloat((totalMemBytes / (1024 ** 3)).toFixed(1));
    const usedGB = parseFloat((usedBytes / (1024 ** 3)).toFixed(1));
    const freeGB = parseFloat((Math.max(0, totalMemBytes - usedBytes) / (1024 ** 3)).toFixed(1));
    const percent = Math.min(100, Math.max(0, Math.round((usedBytes / totalMemBytes) * 100)));

    return { totalGB, usedGB, freeGB, percent };
  } catch {
    const totalGB = parseFloat((totalMemBytes / (1024 ** 3)).toFixed(1));
    const freeMemBytes = os.freemem();
    const usedBytes = totalMemBytes - freeMemBytes;
    const usedGB = parseFloat((usedBytes / (1024 ** 3)).toFixed(1));
    const freeGB = parseFloat((freeMemBytes / (1024 ** 3)).toFixed(1));
    const percent = Math.round((usedBytes / totalMemBytes) * 100);
    return { totalGB, usedGB, freeGB, percent };
  }
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Collect full system health metrics on Mac.
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  let batteryStdout = '';
  try {
    const res = await execFileAsync('pmset', ['-g', 'batt'], { timeout: 2000 });
    batteryStdout = res.stdout;
  } catch {
    // Desktop Mac without pmset batt or permission issue
  }

  let vmStatStdout = '';
  try {
    const res = await execFileAsync('vm_stat', [], { timeout: 2000 });
    vmStatStdout = res.stdout;
  } catch {
    // Fall back to os metrics
  }

  const battery = parseBatteryOutput(batteryStdout);
  const totalMem = os.totalmem();
  const memory = parseVmStat(vmStatStdout, totalMem);

  const cores = os.cpus().length || 1;
  const loadAvg = os.loadavg() as [number, number, number];
  const cpuPercent = Math.min(100, Math.max(0, Math.round((loadAvg[0] / cores) * 100)));

  const uptime = Math.floor(os.uptime());
  const uptimeFormatted = formatUptime(uptime);
  const tunnelActive = await isTunnelActive();

  return {
    battery,
    memory,
    cpu: {
      cores,
      loadAvg,
      percent: cpuPercent,
    },
    uptime,
    uptimeFormatted,
    tunnelActive,
  };
}

/**
 * Puts Mac to sleep safely.
 */
export async function sleepSystem(): Promise<void> {
  try {
    await execFileAsync('osascript', ['-e', 'tell application "System Events" to sleep']);
  } catch (err) {
    // Fallback to pmset sleepnow
    await execFileAsync('pmset', ['sleepnow']);
  }
}
