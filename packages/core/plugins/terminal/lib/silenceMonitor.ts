import { execFile } from 'child_process';
import { unlinkSync } from 'fs';
import { promisify } from 'util';
import { broadcast, getClientCount } from '../../../lib/events.js';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 3000;
const TMUX_COMMAND_TIMEOUT_MS = 2000;
const SILENCE_SECONDS = 15;
const ACTIVE_COOLDOWN_SECONDS = 20;
const ABSENT_POLLS_BEFORE_DELETE = 2;
const TMUX_PANE_FORMAT =
  '#{session_name}\t#{window_activity}\t#{window_active}\t#{pane_active}\t#{pane_current_path}';

export interface SilenceSessionState {
  lastActivitySeconds: number | null;
  activeSinceSeconds: number | null;
  missingPolls?: number;
  path: string;
}

export interface TmuxActivitySnapshot {
  activitySeconds: number;
  path: string;
}

export interface SilenceEvent {
  sessionId: string;
  path: string;
  customTitle?: string;
  customMessage?: string;
}

/** Check if IAP SSH reverse tunnel is currently active */
export async function isTunnelActive(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'gcloud compute start-iap-tunnel.*reverse-tunnel']);
    if (stdout.trim()) return true;
  } catch {}
  try {
    const { stdout } = await execFileAsync('pgrep', ['-u', 'omnitunnel', 'ssh']);
    if (stdout.trim()) return true;
  } catch {}
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', 'ssh.*17717.*reverse-tunnel']);
    if (stdout.trim()) return true;
  } catch {}
  return false;
}

/**
 * Deliver silence alert based on tunnel state:
 * - When tunnel is OFF: notify on local Mac (osascript display notification + sound)
 * - When tunnel is ON: skip Mac native alert to avoid disturbing the Mac, broadcast to phone/browser
 */
export async function deliverSilenceNotification(event: SilenceEvent): Promise<boolean> {
  const tunnelActive = await isTunnelActive();
  const workspaceName = event.path ? event.path.split('/').filter(Boolean).pop() || 'Dự án' : 'Dự án';
  const title = event.customTitle || 'OmniTerm / agy';
  const message = event.customMessage || `Agent đã hoàn thành xong công việc trong [${workspaceName}]!`;

  if (!tunnelActive) {
    // 🖥️ TUNNEL TẮT -> Người dùng đang ngồi tại máy Mac:
    // Bắn thông báo desktop native tại máy Mac kèm âm thanh Glass
    try {
      const appleScript = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" subtitle "Nhiệm vụ hoàn tất" sound name "Glass"`;
      await execFileAsync('osascript', ['-e', appleScript]);
      console.log(`[alert] Mac native desktop notification fired for session=${event.sessionId}`);
    } catch (err) {
      console.error('[alert] Failed to send Mac native notification:', err);
    }
  } else {
    // 📱 TUNNEL BẬT -> Người dùng đang ở xa (truy cập qua điện thoại / browser):
    // Tuyệt đối KHÔNG phát âm thanh hay thông báo trên máy Mac.
    console.log(`[alert] Tunnel is ACTIVE. Skipped Mac native alert; routing to phone/browser.`);
  }

  // Luôn broadcast SSE để browser/điện thoại nhận
  console.log(
    `[alert] broadcast session-silence session=${event.sessionId} cwd=${event.path} tunnel=${tunnelActive} sse_clients=${getClientCount()}`,
  );
  broadcast('session-silence', {
    path: event.path,
    sessionId: event.sessionId,
    tunnelActive,
    title,
    message,
    timestamp: Date.now(),
  });

  return tunnelActive;
}

interface SilenceMonitorGlobalState {
  states: Map<string, SilenceSessionState>;
  legacyCleaned: Set<string>;
  timer: ReturnType<typeof setInterval> | null;
  polling: boolean;
}

const globalState = globalThis as Record<string, unknown>;
const monitorState: SilenceMonitorGlobalState = (globalState.__omniterm_silence_monitor as
  | SilenceMonitorGlobalState
  | undefined) ?? {
  states: new Map<string, SilenceSessionState>(),
  legacyCleaned: new Set<string>(),
  timer: null,
  polling: false,
};
globalState.__omniterm_silence_monitor = monitorState;

export function trackSilenceSession(sessionName: string): void {
  if (!monitorState.states.has(sessionName)) {
    monitorState.states.set(sessionName, {
      lastActivitySeconds: null,
      activeSinceSeconds: null,
      path: '',
    });
  }
  disableLegacySilenceMonitoring(sessionName);
  ensurePoller();
}

export function untrackSilenceSession(sessionName: string): void {
  monitorState.states.delete(sessionName);
  cleanupSilenceSession(sessionName);
}

function cleanupSilenceSession(sessionName: string): void {
  // A later session can reuse the same tmux name; let that new session clear
  // any freshly installed legacy hooks when it starts tracking.
  monitorState.legacyCleaned.delete(sessionName);
  removeLegacyStateFile(sessionName);
  if (monitorState.states.size === 0) {
    stopPoller();
  }
}

function ensurePoller(): void {
  if (monitorState.timer) return;
  monitorState.timer = setInterval(() => {
    void pollSilenceSessions();
  }, POLL_INTERVAL_MS);
  monitorState.timer.unref?.();
}

function stopPoller(): void {
  if (!monitorState.timer) return;
  clearInterval(monitorState.timer);
  monitorState.timer = null;
}

export async function pollSilenceSessions(): Promise<void> {
  if (monitorState.polling || monitorState.states.size === 0) return;

  monitorState.polling = true;
  try {
    const trackedSessions = new Set(monitorState.states.keys());
    const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', TMUX_PANE_FORMAT], {
      encoding: 'utf-8',
      timeout: TMUX_COMMAND_TIMEOUT_MS,
    });
    const snapshots = parseTmuxActivitySnapshots(stdout, trackedSessions);
    updateSilenceStates(
      monitorState.states,
      snapshots,
      nowSeconds(),
      (event) => {
        void deliverSilenceNotification(event);
      },
      { onSessionDeleted: cleanupSilenceSession, trackedSessions },
    );
  } catch {
    // Tmux may be absent while all sessions are closing or before the server
    // has any panes. The next interval will retry if sessions remain tracked.
  } finally {
    monitorState.polling = false;
  }
}

export function parseTmuxActivitySnapshots(
  output: string,
  trackedSessions: ReadonlySet<string>,
): Map<string, TmuxActivitySnapshot> {
  const snapshots = new Map<string, TmuxActivitySnapshot & { activePaneSeen: boolean }>();

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [sessionName, activityText, windowActiveText, paneActiveText, ...pathParts] =
      line.split('\t');
    if (!sessionName || !trackedSessions.has(sessionName)) continue;

    const normalizedActivity = activityText?.trim();
    if (!normalizedActivity) continue;

    const activitySeconds = Number(normalizedActivity);
    if (!Number.isFinite(activitySeconds)) continue;

    const path = pathParts.join('\t').trim();
    const isActivePane = windowActiveText === '1' && paneActiveText === '1';
    const current = snapshots.get(sessionName);
    if (!current) {
      snapshots.set(sessionName, { activitySeconds, path, activePaneSeen: isActivePane });
      continue;
    }

    if (activitySeconds > current.activitySeconds) {
      current.activitySeconds = activitySeconds;
    }
    if (isActivePane || !current.activePaneSeen) {
      current.path = path;
      current.activePaneSeen = current.activePaneSeen || isActivePane;
    }
  }

  return new Map(
    [...snapshots].map(([sessionName, snapshot]) => [
      sessionName,
      { activitySeconds: snapshot.activitySeconds, path: snapshot.path },
    ]),
  );
}

export function updateSilenceStates(
  states: Map<string, SilenceSessionState>,
  snapshots: ReadonlyMap<string, TmuxActivitySnapshot>,
  currentSeconds: number,
  emit: (event: SilenceEvent) => void,
  options: {
    silenceSeconds?: number;
    activeCooldownSeconds?: number;
    absentPollsBeforeDelete?: number;
    onSessionDeleted?: (sessionName: string) => void;
    trackedSessions?: ReadonlySet<string>;
  } = {},
): void {
  const silenceSeconds = options.silenceSeconds ?? SILENCE_SECONDS;
  const activeCooldownSeconds = options.activeCooldownSeconds ?? ACTIVE_COOLDOWN_SECONDS;
  const absentPollsBeforeDelete = options.absentPollsBeforeDelete ?? ABSENT_POLLS_BEFORE_DELETE;

  for (const [sessionName, state] of states) {
    if (options.trackedSessions && !options.trackedSessions.has(sessionName)) {
      continue;
    }

    const snapshot = snapshots.get(sessionName);
    if (!snapshot) {
      state.missingPolls = (state.missingPolls ?? 0) + 1;
      if (state.missingPolls >= absentPollsBeforeDelete) {
        states.delete(sessionName);
        options.onSessionDeleted?.(sessionName);
      }
      continue;
    }
    state.missingPolls = 0;

    state.path = snapshot.path;

    if (state.lastActivitySeconds === null) {
      state.lastActivitySeconds = snapshot.activitySeconds;
      continue;
    }

    if (snapshot.activitySeconds < state.lastActivitySeconds) {
      state.lastActivitySeconds = snapshot.activitySeconds;
      state.activeSinceSeconds = null;
      continue;
    }

    if (snapshot.activitySeconds > state.lastActivitySeconds) {
      if (state.activeSinceSeconds === null) {
        state.activeSinceSeconds = snapshot.activitySeconds;
      }
      state.lastActivitySeconds = snapshot.activitySeconds;
      continue;
    }

    if (
      state.activeSinceSeconds !== null &&
      currentSeconds - state.lastActivitySeconds >= silenceSeconds
    ) {
      if (state.lastActivitySeconds - state.activeSinceSeconds < activeCooldownSeconds) {
        state.activeSinceSeconds = null;
        continue;
      }
      if (state.path) {
        emit({ sessionId: sessionName, path: state.path });
        state.activeSinceSeconds = null;
      }
    }
  }
}

function disableLegacySilenceMonitoring(sessionName: string): void {
  if (monitorState.legacyCleaned.has(sessionName)) return;
  monitorState.legacyCleaned.add(sessionName);

  void execFileAsync(
    'tmux',
    [
      'set-hook',
      '-u',
      '-t',
      sessionName,
      'alert-activity',
      ';',
      'set-hook',
      '-u',
      '-t',
      sessionName,
      'alert-silence',
      ';',
      'set-option',
      '-t',
      sessionName,
      'activity-action',
      'none',
      ';',
      'set-option',
      '-t',
      sessionName,
      'silence-action',
      'none',
      ';',
      'set-window-option',
      '-t',
      sessionName,
      'monitor-activity',
      'off',
      ';',
      'set-window-option',
      '-t',
      sessionName,
      'monitor-silence',
      '0',
    ],
    { timeout: TMUX_COMMAND_TIMEOUT_MS },
  )
    .catch(() => {
      // Session may already be gone. Polling will drop it once tmux omits it.
    })
    .finally(() => removeLegacyStateFile(sessionName));
}

function removeLegacyStateFile(sessionName: string): void {
  try {
    unlinkSync(`/tmp/omniterm-silence-${sessionName}`);
  } catch {
    // No legacy state file exists for Node-polled sessions.
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
