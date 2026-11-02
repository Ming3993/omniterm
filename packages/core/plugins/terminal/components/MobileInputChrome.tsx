'use client';

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useKeyboardInset } from '../../../app/useKeyboardInset';
import {
  TAB,
  ESC,
  ETX,
  sendComposed,
  sendDescriptor,
  sendData,
  type ArrowDir,
} from '../lib/terminalInput';

export interface SystemHealthData {
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

export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'header';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface FileDiffData {
  file: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export interface GitDiffData {
  isGit: boolean;
  repoRoot: string;
  files: FileDiffData[];
  summary: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}

interface Props {
  /** Accessor for the active terminal iframe's contentWindow (lazy: read at send time). */
  getWindow: () => Window | null;
  /** Id of the active terminal session. */
  activeSessionId: string | null;
  /** Active workspace path (for git diff queries). */
  activePath?: string | null;
  /** Soft-reconnect callback for active terminal iframe. */
  onReconnectTerminal?: () => void;
}

interface ActionChip {
  id: string;
  label: string;
  ariaLabel: string;
  action: () => void;
  variant?: 'success' | 'danger' | 'accent' | 'warning' | 'default';
}

/** Suppresses focus theft when active (kept for test compatibility). */
export const keepFocusIf =
  (active: boolean) => (e: { preventDefault: () => void }) => {
    if (active) e.preventDefault();
  };

/**
 * Mobile-friendly AI Terminal Chrome (ChatGPT & Gemini App Experience):
 *  - Floating Navigation Pill (▲ / ▼) on the right for history & menu choices.
 *  - AI Prompt Bar with Voice-to-Text (Microphone) + circular Send button.
 *  - Quick Action Chips (Approve y/n, ^C, Tab, Esc, /plan, /goal, Lock).
 *  - Remote Mac Health Bar (Battery %, RAM, CPU, Sleep Mac).
 *  - Mobile Code Diff Viewer (Color-coded Git Diff with inline Approve/Reject).
 *  - Network Resilience & Auto-Reconnect (Soft-reconnect with zero prompt loss).
 */
export default function MobileInputChrome({
  getWindow,
  activeSessionId,
  activePath,
  onReconnectTerminal,
}: Props) {
  const kbInset = useKeyboardInset();
  const [isListening, setIsListening] = useState(false);
  const [notificationToast, setNotificationToast] = useState<{
    title: string;
    message: string;
    timestamp: number;
    type?: 'success' | 'info' | 'warning';
  } | null>(null);

  const [barOpen, setBarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('omniterm.mobileBar.open') !== 'false';
    } catch {
      return true;
    }
  });

  // Feature 3: Remote Mac Health state
  const [health, setHealth] = useState<SystemHealthData | null>(null);
  const [showHealthModal, setShowHealthModal] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [confirmSleep, setConfirmSleep] = useState(false);

  // Feature 5: Network Resilience state
  const [connectionStatus, setConnectionStatus] = useState<'online' | 'offline' | 'reconnecting'>('online');

  // Feature 6: Mobile Code Diff Viewer state
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [diffData, setDiffData] = useState<GitDiffData | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [selectedFileIdx, setSelectedFileIdx] = useState(0);

  const composeRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const topBtnRef = useRef<HTMLButtonElement>(null);
  const bottomBtnRef = useRef<HTMLButtonElement>(null);

  const isComposingRef = useRef(false);
  const isInteractingRef = useRef(false);
  const lastActionTime = useRef<number>(0);

  // -------------------------------------------------------------
  // Feature 3: Remote Mac Health Telemetry
  // -------------------------------------------------------------
  const fetchHealth = useCallback(async () => {
    try {
      setHealthLoading(true);
      const res = await fetch('/api/system-health', { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        if (body.ok && body.health) {
          setHealth(body.health);
        }
      }
    } catch {
      // Offline or network error
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        fetchHealth();
      }
    }, 25000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const handleSleepMac = async () => {
    try {
      setConfirmSleep(false);
      setShowHealthModal(false);
      setNotificationToast({
        title: '💤 Cho Mac ngủ',
        message: 'Đã gửi lệnh đưa Mac vào chế độ ngủ...',
        timestamp: Date.now(),
        type: 'info',
      });
      await fetch('/api/system-sleep', { method: 'POST' });
    } catch (err) {
      setNotificationToast({
        title: 'Lỗi',
        message: 'Không thể gửi lệnh ngủ cho Mac: ' + String(err),
        timestamp: Date.now(),
        type: 'warning',
      });
    }
  };

  // -------------------------------------------------------------
  // Feature 5: Network Resilience & Auto-Reconnect
  // -------------------------------------------------------------
  const triggerSoftReconnect = useCallback(async () => {
    setConnectionStatus('reconnecting');
    setNotificationToast({
      title: '🔄 Kết nối mạng',
      message: 'Đang khôi phục kết nối tới Mac & terminal...',
      timestamp: Date.now(),
      type: 'info',
    });

    try {
      // 1. Soft reconnect active iframe without losing prompt text
      onReconnectTerminal?.();

      // 2. Ping backend health to verify connection
      const res = await fetch('/api/session-env', { cache: 'no-store' });
      if (res.ok) {
        setConnectionStatus('online');
        fetchHealth();
        setNotificationToast({
          title: '🟢 Đã kết nối',
          message: 'Kết nối tới agent và Mac đã được khôi phục!',
          timestamp: Date.now(),
          type: 'success',
        });
        return;
      }
    } catch {}

    setConnectionStatus('offline');
    setNotificationToast({
      title: '🔴 Mất kết nối',
      message: 'Chưa thể kết nối lại tới Mac. Vui lòng kiểm tra sóng/tunnel.',
      timestamp: Date.now(),
      type: 'warning',
    });
  }, [onReconnectTerminal, fetchHealth]);

  useEffect(() => {
    const handleOnline = () => {
      triggerSoftReconnect();
    };

    const handleOffline = () => {
      setConnectionStatus('offline');
      setNotificationToast({
        title: '🔴 Mất kết nối mạng',
        message: 'Thiết bị của bạn vừa mất kết nối (4G/Wi-Fi ngắt).',
        timestamp: Date.now(),
        type: 'warning',
      });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [triggerSoftReconnect]);

  // -------------------------------------------------------------
  // Feature 6: Mobile Code Diff Viewer
  // -------------------------------------------------------------
  const fetchDiff = useCallback(async () => {
    try {
      setDiffLoading(true);
      const query = activePath ? `?path=${encodeURIComponent(activePath)}` : '';
      const res = await fetch(`/api/git-diff${query}`, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        if (body.ok && body.diff) {
          setDiffData(body.diff);
          setSelectedFileIdx(0);
        }
      }
    } catch (err) {
      console.warn('Failed to fetch diff:', err);
    } finally {
      setDiffLoading(false);
    }
  }, [activePath]);

  const openDiffViewer = () => {
    setShowDiffModal(true);
    fetchDiff();
  };

  const handleDiffApprove = () => {
    sendData(getWindow(), 'y\r');
    setShowDiffModal(false);
    setNotificationToast({
      title: '✅ Approve (y)',
      message: 'Đã gửi xác nhận Apply thay đổi vào terminal!',
      timestamp: Date.now(),
      type: 'success',
    });
  };

  const handleDiffReject = () => {
    sendData(getWindow(), 'n\r');
    setShowDiffModal(false);
    setNotificationToast({
      title: '❌ Reject (n)',
      message: 'Đã gửi từ chối thay đổi vào terminal!',
      timestamp: Date.now(),
      type: 'warning',
    });
  };

  // -------------------------------------------------------------
  // Smart Silence Monitor Alert (Tunnel-Aware)
  // -------------------------------------------------------------
  useEffect(() => {
    const handleSilenceAlert = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const title = detail.title || 'OmniTerm / agy';
      const message = detail.message || 'Agent đã hoàn thành tác vụ!';

      // 1. Âm thanh chuông báo (Web Audio API Synthesizer)
      playNotificationChime();

      // 2. Rung điện thoại (Haptic Vibration)
      if ('vibrate' in navigator && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate([200, 100, 200]);
        } catch {}
      }

      // 3. Web Notification API (nếu được cấp quyền)
      try {
        if (typeof Notification !== 'undefined') {
          if (Notification.permission === 'granted') {
            new Notification(title, {
              body: message,
              icon: '/apple-touch-icon.png',
              badge: '/apple-touch-icon.png',
            });
          } else if (Notification.permission === 'default') {
            Notification.requestPermission().then((perm) => {
              if (perm === 'granted') {
                new Notification(title, { body: message, icon: '/apple-touch-icon.png' });
              }
            });
          }
        }
      } catch {}

      // 4. In-App Floating Toast Banner
      setNotificationToast({ title, message, timestamp: Date.now(), type: 'success' });
    };

    window.addEventListener('omniterm:session-silence', handleSilenceAlert);
    return () => window.removeEventListener('omniterm:session-silence', handleSilenceAlert);
  }, []);

  // Tự động tắt Toast Banner sau 6 giây
  useEffect(() => {
    if (!notificationToast) return;
    const timer = setTimeout(() => {
      setNotificationToast(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [notificationToast]);

  // Native touch & pointer event guard on the navigation pill buttons:
  useEffect(() => {
    const top = topBtnRef.current;
    const btm = bottomBtnRef.current;
    if (!top || !btm) return;

    const onPointerDownGuard = (e: Event) => {
      isInteractingRef.current = true;
      e.preventDefault();
    };

    top.addEventListener('pointerdown', onPointerDownGuard, { passive: false });
    top.addEventListener('touchstart', onPointerDownGuard, { passive: false });
    top.addEventListener('mousedown', onPointerDownGuard);

    btm.addEventListener('pointerdown', onPointerDownGuard, { passive: false });
    btm.addEventListener('touchstart', onPointerDownGuard, { passive: false });
    btm.addEventListener('mousedown', onPointerDownGuard);

    return () => {
      top.removeEventListener('pointerdown', onPointerDownGuard);
      top.removeEventListener('touchstart', onPointerDownGuard);
      top.removeEventListener('mousedown', onPointerDownGuard);

      btm.removeEventListener('pointerdown', onPointerDownGuard);
      btm.removeEventListener('touchstart', onPointerDownGuard);
      btm.removeEventListener('mousedown', onPointerDownGuard);
    };
  }, []);

  // Publish bottom clearance to terminal layer
  useLayoutEffect(() => {
    const root = document.documentElement;
    const publish = () => {
      const barH = barOpen ? (containerRef.current?.offsetHeight ?? 0) : 0;
      root.style.setProperty('--omniterm-terminal-bottom-inset', `${kbInset + barH}px`);
    };
    publish();
    let ro: ResizeObserver | undefined;
    if (barOpen && containerRef.current && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(publish);
      ro.observe(containerRef.current);
    }
    return () => ro?.disconnect();
  }, [barOpen, kbInset, isListening, health]);

  useEffect(
    () => () => {
      document.documentElement.style.removeProperty('--omniterm-terminal-bottom-inset');
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }
    },
    [],
  );

  useEffect(() => {
    try {
      localStorage.setItem('omniterm.mobileBar.open', String(barOpen));
    } catch {}
  }, [barOpen]);

  /** Dismiss and blur any active element so mobile virtual keyboard drops/remains closed. */
  const dismissKeyboard = () => {
    isComposingRef.current = false;
    isInteractingRef.current = false;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    try {
      const win = getWindow();
      if (win?.document?.activeElement instanceof HTMLElement) {
        win.document.activeElement.blur();
      }
      const helperTa = win?.document?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
      if (helperTa) {
        helperTa.blur();
      }
    } catch {}
  };

  /**
   * Action handler that preserves the current keyboard state:
   * - If keyboard is CLOSED: keeps focus away so keyboard NEVER pops up.
   * - If keyboard is OPEN: immediately re-focuses active input so keyboard NEVER drops down.
   */
  const handlePreserveKeyboard = (fn: () => void) => (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();

    isInteractingRef.current = true;

    const wasComposing = isComposingRef.current || document.activeElement === composeRef.current;
    let wasTerminal = false;
    try {
      const win = getWindow();
      const ta = win?.document?.activeElement;
      if (ta && ta.tagName === 'TEXTAREA') wasTerminal = true;
    } catch {}

    const now = Date.now();
    if (now - lastActionTime.current >= 200) {
      lastActionTime.current = now;
      fn();
    }

    if (wasComposing) {
      composeRef.current?.focus({ preventScroll: true });
      setTimeout(() => {
        composeRef.current?.focus({ preventScroll: true });
        isInteractingRef.current = false;
      }, 50);
    } else if (wasTerminal) {
      try {
        const helper = getWindow()?.document?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        helper?.focus({ preventScroll: true });
      } catch {}
      setTimeout(() => {
        isInteractingRef.current = false;
      }, 50);
    } else {
      dismissKeyboard();
      isInteractingRef.current = false;
    }
  };

  // Guard against accidental triggers while swiping / scrolling horizontally across the chips row
  const isChipDraggingRef = useRef(false);
  const chipTouchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleChipTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    chipTouchStartRef.current = { x: t.clientX, y: t.clientY };
    isChipDraggingRef.current = false;
  };

  const handleChipTouchMove = (e: React.TouchEvent) => {
    if (!chipTouchStartRef.current) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - chipTouchStartRef.current.x);
    const dy = Math.abs(t.clientY - chipTouchStartRef.current.y);
    // If finger moves more than 4px horizontally or vertically, it is a scroll/swipe gesture
    if (dx > 4 || dy > 4) {
      isChipDraggingRef.current = true;
    }
  };

  const handleChipTouchEnd = () => {
    // Keep isChipDraggingRef true for 250ms to swallow any delayed synthetic click event from the drag
    if (isChipDraggingRef.current) {
      setTimeout(() => {
        isChipDraggingRef.current = false;
        chipTouchStartRef.current = null;
      }, 250);
    } else {
      chipTouchStartRef.current = null;
    }
  };

  const handleChipClick = (action: () => void) => (e: React.SyntheticEvent) => {
    if (isChipDraggingRef.current) {
      // Swiping across the bar — ignore tap and prevent sending any command (e.g. Reject 'n')
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    handlePreserveKeyboard(action)(e);
  };

  const sendArrow = (dir: ArrowDir) => {
    sendDescriptor(getWindow(), { id: dir, label: dir, ariaLabel: `${dir} arrow`, type: 'arrow', dir });
  };

  const onSend = () => {
    isComposingRef.current = false;
    isInteractingRef.current = false;
    const field = composeRef.current;
    if (!field) return;
    const val = field.value.trim();
    if (!val) return;
    if (sendComposed(getWindow(), val, true)) {
      field.value = '';
      field.style.height = '38px';
      dismissKeyboard();
    }
  };

  const toggleSpeechRecognition = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Trình duyệt trên thiết bị của bạn không hỗ trợ Web Speech API.');
      return;
    }

    if (isListening) {
      try {
        recognitionRef.current?.stop();
      } catch {}
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'vi-VN';

      recognition.onstart = () => setIsListening(true);
      recognition.onend = () => setIsListening(false);
      recognition.onerror = () => setIsListening(false);

      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        if (composeRef.current && transcript) {
          const prev = composeRef.current.value;
          composeRef.current.value = prev ? `${prev} ${transcript}` : transcript;
          autoResizeTextarea();
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.error('Speech recognition error:', err);
      setIsListening(false);
    }
  };

  const autoResizeTextarea = () => {
    const el = composeRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  // Quick Chips catalog
  const CHIPS: ActionChip[] = [
    {
      id: 'diff',
      label: '🔍 Quick Diff',
      ariaLabel: 'Xem Git Diff code thay đổi',
      variant: 'accent',
      action: openDiffViewer,
    },
    {
      id: 'yes',
      label: '✅ Approve (y)',
      ariaLabel: 'Approve and run',
      variant: 'success',
      action: () => sendData(getWindow(), 'y\r'),
    },
    {
      id: 'no',
      label: '❌ Reject (n)',
      ariaLabel: 'Reject and run',
      variant: 'danger',
      action: () => sendData(getWindow(), 'n\r'),
    },
    {
      id: 'ctrl-c',
      label: '🛑 Stop (^C)',
      ariaLabel: 'Interrupt agent',
      variant: 'danger',
      action: () => sendData(getWindow(), ETX),
    },
    {
      id: 'reconnect',
      label: '🔄 Reconnect',
      ariaLabel: 'Soft-reconnect terminal',
      action: triggerSoftReconnect,
    },
    {
      id: 'health',
      label: '🔋 Mac Health',
      ariaLabel: 'Xem pin và tình trạng Mac',
      action: () => setShowHealthModal(true),
    },
    {
      id: 'tab',
      label: '⇥ Tab',
      ariaLabel: 'Tab key',
      action: () => sendDescriptor(getWindow(), { id: 'tab', label: 'Tab', ariaLabel: 'Tab', type: 'bytes', data: TAB }),
    },
    {
      id: 'esc',
      label: 'Esc',
      ariaLabel: 'Escape key',
      action: () => sendDescriptor(getWindow(), { id: 'esc', label: 'Esc', ariaLabel: 'Escape', type: 'bytes', data: ESC }),
    },
    {
      id: 'plan',
      label: '📋 /plan',
      ariaLabel: 'Slash plan',
      variant: 'accent',
      action: () => sendData(getWindow(), '/plan '),
    },
    {
      id: 'goal',
      label: '🎯 /goal',
      ariaLabel: 'Slash goal',
      variant: 'accent',
      action: () => sendData(getWindow(), '/goal '),
    },
    {
      id: 'agy',
      label: '⚡ agy',
      ariaLabel: 'Start agy',
      action: () => sendData(getWindow(), 'agy\r'),
    },
    {
      id: 'lock',
      label: '🔒 Lock Mac',
      ariaLabel: 'Lock tunnel',
      variant: 'warning',
      action: () => sendData(getWindow(), 'remote-tunnel off\r'),
    },
  ];

  const floatingBottom = barOpen
    ? `calc(${kbInset}px + 140px + env(safe-area-inset-bottom, 0px))`
    : `calc(${kbInset}px + 20px + env(safe-area-inset-bottom, 0px))`;

  const activeDiffFile = diffData?.files?.[selectedFileIdx];

  return (
    <>
      {/* 🔔 FLOATING TOAST BANNER */}
      {notificationToast && (
        <div style={S.toastBanner} onClick={() => setNotificationToast(null)}>
          <div style={S.toastIcon}>
            {notificationToast.type === 'success'
              ? '🎉'
              : notificationToast.type === 'warning'
                ? '⚠️'
                : 'ℹ️'}
          </div>
          <div style={S.toastBody}>
            <div style={S.toastTitle}>{notificationToast.title}</div>
            <div style={S.toastMessage}>{notificationToast.message}</div>
          </div>
          <button
            type="button"
            tabIndex={-1}
            style={S.toastClose}
            onClick={(e) => {
              e.stopPropagation();
              setNotificationToast(null);
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* 🔴 NETWORK OFFLINE / RECONNECTING FLOATING BANNER */}
      {connectionStatus !== 'online' && (
        <div
          style={S.networkBanner}
          onClick={triggerSoftReconnect}
        >
          {connectionStatus === 'reconnecting' ? (
            <span>🔄 Đang khôi phục kết nối...</span>
          ) : (
            <span>🔴 Mất mạng (Chạm để kết nối lại 🔄)</span>
          )}
        </div>
      )}

      {/* 🕹️ FLOATING NAVIGATION PILL (▲ / ▼) */}
      <div
        style={{
          ...S.navPillContainer,
          bottom: floatingBottom,
        }}
      >
        <button
          ref={topBtnRef}
          type="button"
          tabIndex={-1}
          aria-label="Di chuyển lên / Lệnh trước (Arrow Up)"
          style={S.navPillBtnTop}
          onPointerDown={handlePreserveKeyboard(() => sendArrow('up'))}
          onTouchStart={handlePreserveKeyboard(() => sendArrow('up'))}
          onClick={handlePreserveKeyboard(() => sendArrow('up'))}
        >
          ▲
        </button>
        <div style={S.navPillDivider} />
        <button
          ref={bottomBtnRef}
          type="button"
          tabIndex={-1}
          aria-label="Di chuyển xuống / Lệnh kế tiếp (Arrow Down)"
          style={S.navPillBtnBottom}
          onPointerDown={handlePreserveKeyboard(() => sendArrow('down'))}
          onTouchStart={handlePreserveKeyboard(() => sendArrow('down'))}
          onClick={handlePreserveKeyboard(() => sendArrow('down'))}
        >
          ▼
        </button>
      </div>

      {/* 🔘 Nút mở lại thanh chat khi đang thu gọn */}
      {!barOpen && (
        <div
          style={{
            ...S.fabLauncher,
            bottom: `calc(${kbInset}px + 20px + env(safe-area-inset-bottom, 0px))`,
          }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label="Mở thanh chat AI"
            style={S.fabLauncherBtn}
            onPointerDown={handlePreserveKeyboard(() => setBarOpen(true))}
            onTouchStart={handlePreserveKeyboard(() => setBarOpen(true))}
            onClick={handlePreserveKeyboard(() => setBarOpen(true))}
          >
            💬
          </button>
        </div>
      )}

      {/* 💬 CHATGPT / GEMINI APP-STYLE BOTTOM INPUT BAR */}
      {barOpen && (
        <div
          ref={containerRef}
          style={{
            ...S.chatBarContainer,
            bottom: kbInset,
          }}
        >
          {/* Top Status Bar: Remote Mac Health Pill */}
          <div style={S.topStatusBar}>
            <div
              style={S.healthPill}
              onClick={() => setShowHealthModal(true)}
              title="Chạm để xem chi tiết tình trạng Mac"
            >
              {health ? (
                <>
                  <span style={S.healthItem}>
                    {health.battery.hasBattery
                      ? `${health.battery.chargingState === 'charging' ? '⚡' : '🔋'} ${health.battery.percent}%`
                      : '🔌 AC'}
                  </span>
                  <span style={S.healthDot}>•</span>
                  <span style={S.healthItem}>💾 RAM {health.memory.percent}%</span>
                  <span style={S.healthDot}>•</span>
                  <span style={S.healthItem}>⚡ CPU {health.cpu.percent}%</span>
                  <span style={S.healthDot}>•</span>
                  <span style={S.healthItem}>{health.tunnelActive ? '🚇 VM' : '🏠 Mac'}</span>
                </>
              ) : (
                <span style={S.healthItem}>💻 Mac Remote {healthLoading ? '...' : ''}</span>
              )}
            </div>

            {/* Quick Sleep Button */}
            <button
              type="button"
              tabIndex={-1}
              style={S.sleepShortcutBtn}
              onClick={() => {
                setConfirmSleep(true);
                setShowHealthModal(true);
              }}
              title="Cho Mac ngủ"
            >
              💤 Ngủ
            </button>
          </div>

          {/* Hàng Quick Chips cuộn ngang */}
          <div
            style={S.chipsRow}
            onTouchStart={handleChipTouchStart}
            onTouchMove={handleChipTouchMove}
            onTouchEnd={handleChipTouchEnd}
          >
            {CHIPS.map((chip) => {
              const chipStyle = chip.variant
                ? { ...S.chipBase, ...(S[`chip_${chip.variant}`] || {}) }
                : S.chipBase;
              return (
                <button
                  key={chip.id}
                  type="button"
                  tabIndex={-1}
                  aria-label={chip.ariaLabel}
                  style={chipStyle}
                  onFocus={(e) => {
                    // Prevent button from holding DOM focus
                    e.currentTarget.blur();
                  }}
                  onMouseDown={(e) => {
                    // Prevent focus loss on desktop mouse clicks without interfering with mobile touch scroll
                    e.preventDefault();
                  }}
                  onClick={handleChipClick(chip.action)}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>

          {/* Khung nhập liệu Pill-shaped bo tròn như app ChatGPT/Gemini */}
          <div style={S.promptPill}>
            {/* Nút Mic Voice-to-Text */}
            <button
              type="button"
              tabIndex={-1}
              aria-label={isListening ? 'Dừng ghi âm' : 'Nói lệnh qua micro'}
              style={isListening ? S.micListening : S.micBtn}
              onPointerDown={handlePreserveKeyboard(toggleSpeechRecognition)}
              onTouchStart={handlePreserveKeyboard(toggleSpeechRecognition)}
              onClick={handlePreserveKeyboard(toggleSpeechRecognition)}
            >
              {isListening ? '🔴' : '🎙️'}
            </button>

            {/* Ô nhập Textarea */}
            <textarea
              ref={composeRef}
              rows={1}
              placeholder={isListening ? 'Đang lắng nghe bạn nói...' : 'Nhắn tin cho agy hoặc bấm micro…'}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              autoComplete="off"
              style={S.promptInput}
              onFocus={() => {
                isComposingRef.current = true;
              }}
              onBlur={() => {
                if (isInteractingRef.current) return;
                isComposingRef.current = false;
              }}
              onInput={autoResizeTextarea}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onSend();
                }
              }}
            />

            {/* Nút Gửi tròn xanh (Send button) */}
            <button
              type="button"
              tabIndex={-1}
              aria-label="Gửi lệnh cho agent"
              style={S.sendBtn}
              onPointerDown={(e) => {
                e.preventDefault();
                onSend();
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                onSend();
              }}
              onClick={(e) => {
                e.preventDefault();
                onSend();
              }}
            >
              ➤
            </button>

            {/* Nút ẩn thanh chat */}
            <button
              type="button"
              tabIndex={-1}
              aria-label="Thu gọn thanh nhập"
              style={S.hideBtn}
              onPointerDown={(e) => {
                e.preventDefault();
                dismissKeyboard();
                setBarOpen(false);
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                dismissKeyboard();
                setBarOpen(false);
              }}
              onClick={(e) => {
                e.preventDefault();
                dismissKeyboard();
                setBarOpen(false);
              }}
            >
              ⌄
            </button>
          </div>
        </div>
      )}

      {/* 💻 MODAL: REMOTE MAC HEALTH & POWER MANAGEMENT (Feature 3) */}
      {showHealthModal && (
        <div style={S.modalOverlay} onClick={() => setShowHealthModal(false)}>
          <div style={S.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <div style={S.modalTitle}>💻 Tình trạng Mac từ xa</div>
              <button
                type="button"
                tabIndex={-1}
                style={S.modalCloseBtn}
                onClick={() => setShowHealthModal(false)}
              >
                ✕
              </button>
            </div>

            {health ? (
              <div style={S.modalBody}>
                {/* Battery Block */}
                <div style={S.metricBlock}>
                  <div style={S.metricTitle}>
                    {health.battery.hasBattery
                      ? `${health.battery.chargingState === 'charging' ? '⚡ Đang cắm sạc' : '🔋 Đang dùng pin'}`
                      : '🔌 Cắm nguồn trực tiếp'}
                  </div>
                  <div style={S.metricValue}>
                    {health.battery.percent}% {health.battery.timeRemaining ? `• ${health.battery.timeRemaining}` : ''}
                  </div>
                  <div style={S.barTrack}>
                    <div
                      style={{
                        ...S.barFill,
                        width: `${health.battery.percent}%`,
                        background:
                          health.battery.percent > 40
                            ? '#22c55e'
                            : health.battery.percent > 20
                              ? '#eab308'
                              : '#ef4444',
                      }}
                    />
                  </div>
                </div>

                {/* Memory Block */}
                <div style={S.metricBlock}>
                  <div style={S.metricTitle}>💾 Bộ nhớ RAM</div>
                  <div style={S.metricValue}>
                    {health.memory.usedGB} GB / {health.memory.totalGB} GB ({health.memory.percent}%)
                  </div>
                  <div style={S.barTrack}>
                    <div
                      style={{
                        ...S.barFill,
                        width: `${health.memory.percent}%`,
                        background: health.memory.percent > 85 ? '#f97316' : '#3b82f6',
                      }}
                    />
                  </div>
                </div>

                {/* CPU & Uptime Block */}
                <div style={S.metricRow}>
                  <div style={{ ...S.metricBlock, flex: 1, marginRight: 8 }}>
                    <div style={S.metricTitle}>⚡ Tải CPU</div>
                    <div style={S.metricValue}>
                      {health.cpu.percent}% ({health.cpu.cores} cores)
                    </div>
                  </div>
                  <div style={{ ...S.metricBlock, flex: 1 }}>
                    <div style={S.metricTitle}>⏱️ Uptime</div>
                    <div style={S.metricValue}>{health.uptimeFormatted}</div>
                  </div>
                </div>

                {/* Tunnel Status */}
                <div style={S.metricBlock}>
                  <div style={S.metricTitle}>🚇 Reverse Tunnel (GCP VM)</div>
                  <div style={S.metricValue}>
                    {health.tunnelActive ? '🟢 Đang hoạt động (us-west1-b)' : '⚪ Tắt (Local Mac)'}
                  </div>
                </div>

                {/* Confirm Sleep Dialog */}
                {confirmSleep ? (
                  <div style={S.confirmBox}>
                    <div style={S.confirmText}>
                      ⚠️ <b>Xác nhận đưa Mac vào giấc ngủ?</b>
                      <br />
                      Khi Mac ngủ, kết nối từ xa sẽ tạm ngắt cho đến khi Mac được đánh thức.
                    </div>
                    <div style={S.confirmBtns}>
                      <button
                        type="button"
                        tabIndex={-1}
                        style={S.confirmSleepBtn}
                        onClick={handleSleepMac}
                      >
                        💤 Xác nhận ngủ ngay
                      </button>
                      <button
                        type="button"
                        tabIndex={-1}
                        style={S.confirmCancelBtn}
                        onClick={() => setConfirmSleep(false)}
                      >
                        Hủy
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={S.modalActions}>
                    <button
                      type="button"
                      tabIndex={-1}
                      style={S.refreshBtn}
                      onClick={fetchHealth}
                    >
                      🔄 Làm mới
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      style={S.sleepActionBtn}
                      onClick={() => setConfirmSleep(true)}
                    >
                      💤 Cho Mac ngủ
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div style={S.modalLoading}>Đang kiểm tra kết nối tới Mac...</div>
            )}
          </div>
        </div>
      )}

      {/* 🔍 MODAL: MOBILE CODE DIFF VIEWER (Feature 6) */}
      {showDiffModal && (
        <div style={S.diffModalOverlay} onClick={() => setShowDiffModal(false)}>
          <div style={S.diffModalCard} onClick={(e) => e.stopPropagation()}>
            {/* Diff Header */}
            <div style={S.diffHeader}>
              <div style={S.diffHeaderLeft}>
                <span style={S.diffTitle}>🔍 Git Diff</span>
                {diffData && (
                  <span style={S.diffStatsBadge}>
                    <span style={{ color: '#4ade80' }}>+{diffData.summary.additions}</span>{' '}
                    <span style={{ color: '#f87171' }}>-{diffData.summary.deletions}</span>{' '}
                    <span style={{ color: '#94a3b8' }}>({diffData.files.length} files)</span>
                  </span>
                )}
              </div>
              <div style={S.diffHeaderRight}>
                <button
                  type="button"
                  tabIndex={-1}
                  style={S.diffRefreshBtn}
                  onClick={fetchDiff}
                  title="Tải lại Diff"
                >
                  🔄
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  style={S.diffCloseBtn}
                  onClick={() => setShowDiffModal(false)}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* File Selector Tabs */}
            {diffData && diffData.files.length > 0 && (
              <div style={S.diffFileTabs}>
                {diffData.files.map((file, idx) => {
                  const isSel = idx === selectedFileIdx;
                  return (
                    <button
                      key={file.file}
                      type="button"
                      tabIndex={-1}
                      style={isSel ? S.diffFileTabActive : S.diffFileTab}
                      onClick={() => setSelectedFileIdx(idx)}
                    >
                      <span>{file.file.split('/').pop()}</span>
                      <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.8 }}>
                        (+{file.additions} -{file.deletions})
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Diff Viewer Body */}
            <div style={S.diffBody}>
              {diffLoading ? (
                <div style={S.diffEmptyState}>Đang tải code diff...</div>
              ) : !diffData || !diffData.isGit ? (
                <div style={S.diffEmptyState}>Thư mục hiện tại không phải Git repository.</div>
              ) : diffData.files.length === 0 ? (
                <div style={S.diffEmptyState}>
                  ✨ Working tree clean! Không có thay đổi nào trong git.
                </div>
              ) : activeDiffFile ? (
                <div style={S.diffCodeContainer}>
                  <div style={S.diffFilePathHeader}>
                    📄 <b>{activeDiffFile.file}</b> ({activeDiffFile.status})
                  </div>
                  {activeDiffFile.lines.length === 0 ? (
                    <div style={S.diffFileUntracked}>
                      Tệp chưa được theo dõi (untracked file).
                    </div>
                  ) : (
                    <pre style={S.diffPre}>
                      {activeDiffFile.lines.map((line, lIdx) => {
                        let lineStyle = S.diffLineContext;
                        let prefix = ' ';
                        if (line.type === 'add') {
                          lineStyle = S.diffLineAdd;
                          prefix = '+';
                        } else if (line.type === 'del') {
                          lineStyle = S.diffLineDel;
                          prefix = '-';
                        } else if (line.type === 'header') {
                          lineStyle = S.diffLineHeader;
                          prefix = '@';
                        }

                        return (
                          <div key={lIdx} style={lineStyle}>
                            <span style={S.diffGutter}>
                              {line.newLineNo ?? line.oldLineNo ?? ''}
                            </span>
                            <span style={S.diffPrefix}>{prefix}</span>
                            <span style={S.diffCodeContent}>{line.content}</span>
                          </div>
                        );
                      })}
                    </pre>
                  )}
                </div>
              ) : null}
            </div>

            {/* Bottom Actions Bar (Approve / Reject directly on mobile) */}
            <div style={S.diffFooter}>
              <button
                type="button"
                tabIndex={-1}
                style={S.diffApproveBtn}
                onClick={handleDiffApprove}
              >
                ✅ Approve (y)
              </button>
              <button
                type="button"
                tabIndex={-1}
                style={S.diffRejectBtn}
                onClick={handleDiffReject}
              >
                ❌ Reject (n)
              </button>
              <button
                type="button"
                tabIndex={-1}
                style={S.diffDismissBtn}
                onClick={() => setShowDiffModal(false)}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Web Audio API Synthesizer: phát tiếng chuông báo hoàn thành nhiệm vụ nhẹ nhàng */
function playNotificationChime(): void {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(880, now + 0.15); // A5
    osc2.frequency.setValueAtTime(1174.66, now + 0.3); // D6

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.3);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.7);
  } catch (err) {
    console.warn('[chime] Web Audio playback failed:', err);
  }
}

const BAR_Z = 120;

const S: Record<string, React.CSSProperties> = {
  // 🕹️ Floating Nav Pill (▲ / ▼) — Glassmorphism
  navPillContainer: {
    position: 'fixed',
    right: 14,
    zIndex: BAR_Z + 10,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: 48,
    borderRadius: 24,
    background: 'rgba(28, 30, 38, 0.88)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.25)',
    overflow: 'hidden',
    transition: 'bottom 0.2s cubic-bezier(0.2, 0, 0, 1)',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'manipulation',
  },
  navPillBtnTop: {
    width: '100%',
    height: 44,
    border: 'none',
    background: 'transparent',
    color: '#e2e8f0',
    fontSize: 16,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
    touchAction: 'manipulation',
  },
  navPillDivider: {
    width: '70%',
    height: 1,
    background: 'rgba(255, 255, 255, 0.12)',
  },
  navPillBtnBottom: {
    width: '100%',
    height: 44,
    border: 'none',
    background: 'transparent',
    color: '#e2e8f0',
    fontSize: 16,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
    touchAction: 'manipulation',
  },

  // 🔘 FAB Launcher
  fabLauncher: {
    position: 'fixed',
    left: 14,
    zIndex: BAR_Z + 10,
  },
  fabLauncherBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    background: 'rgba(28, 30, 38, 0.92)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    fontSize: 20,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#e2e8f0',
    outline: 'none',
  },

  // 💬 ChatGPT / Gemini Style Chat Container
  chatBarContainer: {
    position: 'fixed',
    left: 0,
    right: 0,
    zIndex: BAR_Z,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '6px 12px calc(8px + env(safe-area-inset-bottom, 0px))',
    background: 'linear-gradient(to top, rgba(13, 14, 18, 0.98) 80%, rgba(13, 14, 18, 0.8) 100%)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    borderTop: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 -4px 24px rgba(0, 0, 0, 0.5)',
    transition: 'bottom 0.2s cubic-bezier(0.2, 0, 0, 1)',
  },

  // Top Status Bar in Mobile Chrome
  topStatusBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 2px',
  },
  healthPill: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 10px',
    borderRadius: 12,
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    fontSize: 11,
    color: '#94a3b8',
    cursor: 'pointer',
  },
  healthItem: {
    fontWeight: 500,
  },
  healthDot: {
    opacity: 0.4,
  },
  sleepShortcutBtn: {
    background: 'rgba(239, 68, 68, 0.12)',
    border: '1px solid rgba(239, 68, 68, 0.25)',
    color: '#f87171',
    borderRadius: 12,
    padding: '3px 8px',
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
  },

  // Hàng Quick Chips cuộn ngang
  chipsRow: {
    display: 'flex',
    gap: 6,
    overflowX: 'auto',
    overflowY: 'hidden',
    paddingBottom: 2,
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
    touchAction: 'pan-x',
  },
  chipBase: {
    flexShrink: 0,
    padding: '5px 10px',
    borderRadius: 14,
    background: 'rgba(255, 255, 255, 0.07)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    whiteSpace: 'nowrap',
    touchAction: 'pan-x',
    WebkitTapHighlightColor: 'transparent',
    outline: 'none',
  },
  chip_success: {
    background: 'rgba(34, 197, 94, 0.15)',
    border: '1px solid rgba(34, 197, 94, 0.35)',
    color: '#4ade80',
    fontWeight: 600,
  },
  chip_danger: {
    background: 'rgba(239, 68, 68, 0.15)',
    border: '1px solid rgba(239, 68, 68, 0.35)',
    color: '#f87171',
  },
  chip_accent: {
    background: 'rgba(56, 189, 248, 0.15)',
    border: '1px solid rgba(56, 189, 248, 0.35)',
    color: '#38bdf8',
  },
  chip_warning: {
    background: 'rgba(234, 179, 8, 0.15)',
    border: '1px solid rgba(234, 179, 8, 0.35)',
    color: '#fde047',
  },

  // Khung nhập Prompt dạng Pill
  promptPill: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 6px',
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: 24,
    boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.25)',
  },
  micBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    border: 'none',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#e2e8f0',
    fontSize: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
  },
  micListening: {
    width: 34,
    height: 34,
    borderRadius: 17,
    border: 'none',
    background: 'rgba(239, 68, 68, 0.3)',
    color: '#ef4444',
    fontSize: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    animation: 'pulse 1.2s infinite',
  },
  promptInput: {
    flex: 1,
    minHeight: 22,
    maxHeight: 120,
    padding: '6px 8px',
    border: 'none',
    background: 'transparent',
    color: '#f8fafc',
    fontSize: 14,
    lineHeight: '20px',
    resize: 'none',
    outline: 'none',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    border: 'none',
    background: '#38bdf8',
    color: '#0f172a',
    fontSize: 15,
    fontWeight: 'bold',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    boxShadow: '0 2px 8px rgba(56, 189, 248, 0.4)',
  },
  hideBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    border: 'none',
    background: 'transparent',
    color: '#94a3b8',
    fontSize: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
  },

  // 🔔 Toast Notification Banner
  toastBanner: {
    position: 'fixed',
    top: 14,
    left: 12,
    right: 12,
    zIndex: BAR_Z + 100,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    borderRadius: 14,
    background: 'rgba(24, 26, 34, 0.95)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid rgba(56, 189, 248, 0.3)',
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.6)',
    animation: 'slideDown 0.3s ease-out',
  },
  toastIcon: {
    fontSize: 20,
  },
  toastBody: {
    flex: 1,
    minWidth: 0,
  },
  toastTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#f8fafc',
  },
  toastMessage: {
    fontSize: 12,
    color: '#cbd5e1',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  toastClose: {
    border: 'none',
    background: 'transparent',
    color: '#94a3b8',
    fontSize: 14,
    cursor: 'pointer',
    padding: 4,
  },

  // 🔴 Network Offline Banner
  networkBanner: {
    position: 'fixed',
    top: 60,
    left: 20,
    right: 20,
    zIndex: BAR_Z + 90,
    padding: '6px 12px',
    borderRadius: 20,
    background: 'rgba(239, 68, 68, 0.92)',
    backdropFilter: 'blur(10px)',
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 600,
    textAlign: 'center',
    boxShadow: '0 4px 16px rgba(239, 68, 68, 0.4)',
    cursor: 'pointer',
  },

  // 💻 Modal Styles (Feature 3: System Health)
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: BAR_Z + 80,
    background: 'rgba(0, 0, 0, 0.75)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    borderRadius: 20,
    background: '#161821',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    boxShadow: '0 20px 40px rgba(0, 0, 0, 0.7)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: '#f8fafc',
  },
  modalCloseBtn: {
    border: 'none',
    background: 'transparent',
    color: '#94a3b8',
    fontSize: 16,
    cursor: 'pointer',
  },
  modalBody: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  metricBlock: {
    padding: '10px 12px',
    borderRadius: 12,
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
  },
  metricRow: {
    display: 'flex',
  },
  metricTitle: {
    fontSize: 12,
    color: '#94a3b8',
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 14,
    fontWeight: 600,
    color: '#f8fafc',
  },
  barTrack: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    background: 'rgba(255, 255, 255, 0.08)',
    marginTop: 6,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },
  modalActions: {
    display: 'flex',
    gap: 10,
    marginTop: 6,
  },
  refreshBtn: {
    flex: 1,
    padding: '10px',
    borderRadius: 12,
    border: '1px solid rgba(255, 255, 255, 0.15)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },
  sleepActionBtn: {
    flex: 1,
    padding: '10px',
    borderRadius: 12,
    border: '1px solid rgba(239, 68, 68, 0.3)',
    background: 'rgba(239, 68, 68, 0.15)',
    color: '#f87171',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  confirmBox: {
    padding: '12px',
    borderRadius: 12,
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
  },
  confirmText: {
    fontSize: 12,
    color: '#fca5a5',
    lineHeight: '18px',
    marginBottom: 10,
  },
  confirmBtns: {
    display: 'flex',
    gap: 8,
  },
  confirmSleepBtn: {
    flex: 1,
    padding: '8px',
    borderRadius: 10,
    border: 'none',
    background: '#ef4444',
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  confirmCancelBtn: {
    padding: '8px 14px',
    borderRadius: 10,
    border: '1px solid rgba(255, 255, 255, 0.15)',
    background: 'transparent',
    color: '#e2e8f0',
    fontSize: 12,
    cursor: 'pointer',
  },
  modalLoading: {
    padding: 30,
    textAlign: 'center',
    color: '#94a3b8',
    fontSize: 13,
  },

  // 🔍 Diff Modal Styles (Feature 6: Mobile Code Diff Viewer)
  diffModalOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: BAR_Z + 80,
    background: 'rgba(0, 0, 0, 0.8)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'flex-end',
  },
  diffModalCard: {
    width: '100%',
    height: '85vh',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    background: '#0d1117',
    borderTop: '1px solid rgba(255, 255, 255, 0.15)',
    boxShadow: '0 -10px 40px rgba(0, 0, 0, 0.8)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  diffHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid #21262d',
    background: '#161b22',
  },
  diffHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  diffTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: '#f0f6fc',
  },
  diffStatsBadge: {
    fontSize: 12,
    fontWeight: 500,
    background: '#21262d',
    padding: '2px 8px',
    borderRadius: 10,
  },
  diffHeaderRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  diffRefreshBtn: {
    border: 'none',
    background: 'transparent',
    color: '#8b949e',
    fontSize: 15,
    cursor: 'pointer',
  },
  diffCloseBtn: {
    border: 'none',
    background: 'transparent',
    color: '#8b949e',
    fontSize: 16,
    cursor: 'pointer',
  },
  diffFileTabs: {
    display: 'flex',
    gap: 6,
    padding: '8px 12px',
    background: '#161b22',
    borderBottom: '1px solid #21262d',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
  },
  diffFileTab: {
    flexShrink: 0,
    padding: '4px 10px',
    borderRadius: 8,
    border: '1px solid #30363d',
    background: '#0d1117',
    color: '#8b949e',
    fontSize: 12,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
  diffFileTabActive: {
    flexShrink: 0,
    padding: '4px 10px',
    borderRadius: 8,
    border: '1px solid #388bfd',
    background: 'rgba(56, 139, 253, 0.15)',
    color: '#58a6ff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
  diffBody: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    background: '#0d1117',
  },
  diffEmptyState: {
    padding: '40px 20px',
    textAlign: 'center',
    color: '#8b949e',
    fontSize: 14,
  },
  diffCodeContainer: {
    paddingBottom: 20,
  },
  diffFilePathHeader: {
    padding: '6px 12px',
    background: '#161b22',
    color: '#c9d1d9',
    fontSize: 12,
    borderBottom: '1px solid #21262d',
  },
  diffFileUntracked: {
    padding: '20px',
    color: '#8b949e',
    fontSize: 13,
  },
  diffPre: {
    margin: 0,
    padding: '4px 0',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 11,
    lineHeight: '18px',
  },
  diffLineContext: {
    display: 'flex',
    color: '#c9d1d9',
    padding: '0 4px',
  },
  diffLineAdd: {
    display: 'flex',
    background: 'rgba(46, 160, 67, 0.18)',
    color: '#3fb950',
    borderLeft: '3px solid #2ea043',
    padding: '0 4px 0 1px',
  },
  diffLineDel: {
    display: 'flex',
    background: 'rgba(248, 81, 73, 0.18)',
    color: '#f85149',
    borderLeft: '3px solid #da3633',
    padding: '0 4px 0 1px',
  },
  diffLineHeader: {
    display: 'flex',
    background: 'rgba(56, 139, 253, 0.15)',
    color: '#79c0ff',
    padding: '2px 4px',
    fontSize: 10,
  },
  diffGutter: {
    width: 32,
    color: '#484f58',
    textAlign: 'right',
    paddingRight: 8,
    flexShrink: 0,
    userSelect: 'none',
  },
  diffPrefix: {
    width: 12,
    textAlign: 'center',
    flexShrink: 0,
    userSelect: 'none',
  },
  diffCodeContent: {
    whiteSpace: 'pre',
    overflowX: 'visible',
  },
  diffFooter: {
    display: 'flex',
    gap: 8,
    padding: '10px 14px calc(10px + env(safe-area-inset-bottom, 0px))',
    background: '#161b22',
    borderTop: '1px solid #21262d',
  },
  diffApproveBtn: {
    flex: 2,
    padding: '10px',
    borderRadius: 12,
    border: 'none',
    background: '#238636',
    color: '#ffffff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  diffRejectBtn: {
    flex: 2,
    padding: '10px',
    borderRadius: 12,
    border: 'none',
    background: '#da3633',
    color: '#ffffff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  diffDismissBtn: {
    flex: 1,
    padding: '10px',
    borderRadius: 12,
    border: '1px solid #30363d',
    background: '#21262d',
    color: '#c9d1d9',
    fontSize: 13,
    cursor: 'pointer',
  },
};
