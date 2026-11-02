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

async function sha256(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

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

  // Feature 6: Terminal Scroll Tracking ("Jump to Bottom")
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  // Feature 4: Tunnel Lease Timer state
  const [tunnelTimer, setTunnelTimer] = useState<{
    active: boolean;
    remainingSeconds: number;
    formatted?: string;
  } | null>(null);

  // Feature 2: WebAuthn Biometric & PIN Lock state
  const [bioEnabled, setBioEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('omniterm.bioLock.enabled') === 'true';
    } catch {
      return false;
    }
  });
  const [isBioLocked, setIsBioLocked] = useState<boolean>(() => {
    try {
      return localStorage.getItem('omniterm.bioLock.enabled') === 'true';
    } catch {
      return false;
    }
  });
  const [autoLockMinutes, setAutoLockMinutes] = useState<number>(() => {
    try {
      const val = localStorage.getItem('omniterm.bioLock.autoLockMinutes');
      return val ? parseInt(val, 10) : 3;
    } catch {
      return 3;
    }
  });
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');
  const [showPinSetupModal, setShowPinSetupModal] = useState(false);
  const [setupPinValue, setSetupPinValue] = useState('');
  const [setupPinError, setSetupPinError] = useState('');

  // Feature 5: PWA Standalone Detection & Installation Prompt
  const [isStandalone] = useState<boolean>(() => {
    try {
      return (
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as any).standalone === true
      );
    } catch {
      return false;
    }
  });
  const [showPwaModal, setShowPwaModal] = useState(false);
  const [pwaInstallPrompt, setPwaInstallPrompt] = useState<any>(null);

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
        title: 'Sleep Mode',
        message: 'Đang gửi lệnh đưa Mac vào chế độ ngủ...',
        timestamp: Date.now(),
        type: 'info',
      });
      await fetch('/api/system-sleep', { method: 'POST' });
    } catch (err) {
      setNotificationToast({
        title: 'Error',
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
      title: 'Reconnecting',
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
          title: 'Connected',
          message: 'Kết nối tới agent và Mac đã được khôi phục.',
          timestamp: Date.now(),
          type: 'success',
        });
        return;
      }
    } catch {}

    setConnectionStatus('offline');
    setNotificationToast({
      title: 'Connection Lost',
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
        title: 'Offline',
        message: 'Thiết bị của bạn vừa mất kết nối mạng.',
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
  // Feature 1: Stealth Mode (Tắt màn hình Mac từ xa)
  // -------------------------------------------------------------
  const handleSleepDisplay = useCallback(async () => {
    try {
      setNotificationToast({
        title: 'Stealth Mode',
        message: 'Đang tắt màn hình Mac (CPU & Agent vẫn chạy ngầm)...',
        timestamp: Date.now(),
        type: 'info',
      });
      const res = await fetch('/api/system-displaysleep', { method: 'POST' });
      if (res.ok) {
        setNotificationToast({
          title: 'Stealth Active',
          message: 'Màn hình Mac đã tắt hoàn toàn. Agent vẫn tiếp tục xử lý.',
          timestamp: Date.now(),
          type: 'success',
        });
      }
    } catch (err) {
      setNotificationToast({
        title: 'Error',
        message: 'Không thể tắt màn hình: ' + String(err),
        timestamp: Date.now(),
        type: 'warning',
      });
    }
  }, []);

  // -------------------------------------------------------------
  // Feature 4: Tunnel Lease Timer (Hẹn giờ tự đóng Tunnel)
  // -------------------------------------------------------------
  const fetchTunnelTimer = useCallback(async () => {
    try {
      const res = await fetch('/api/tunnel-timer', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          setTunnelTimer({
            active: data.active,
            remainingSeconds: data.remainingSeconds,
            formatted: data.formatted,
          });
        }
      }
    } catch {}
  }, []);

  const handleSetTunnelTimer = useCallback(async (minutes: number) => {
    try {
      const res = await fetch('/api/tunnel-timer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes }),
      });
      const data = await res.json();
      if (data.ok) {
        setTunnelTimer({
          active: data.active,
          remainingSeconds: data.remainingSeconds,
          formatted: data.formatted,
        });
        setNotificationToast({
          title: minutes > 0 ? '⏱️ Đã đặt hẹn giờ tắt tunnel' : '⏱️ Đã hủy hẹn giờ',
          message:
            minutes > 0
              ? `Tunnel sẽ tự động đóng sau ${minutes} phút (${data.formatted}).`
              : 'Đã xóa bộ đếm thời gian tự tắt tunnel.',
          timestamp: Date.now(),
          type: 'info',
        });
      }
    } catch (err) {
      setNotificationToast({
        title: 'Lỗi',
        message: 'Không thể thiết lập hẹn giờ: ' + String(err),
        timestamp: Date.now(),
        type: 'warning',
      });
    }
  }, []);

  // Countdown seconds locally for real-time timer feedback
  useEffect(() => {
    if (!tunnelTimer?.active || tunnelTimer.remainingSeconds <= 0) return;
    const iv = setInterval(() => {
      setTunnelTimer((prev) => {
        if (!prev || !prev.active || prev.remainingSeconds <= 1) {
          fetchTunnelTimer();
          return prev ? { ...prev, active: false, remainingSeconds: 0 } : null;
        }
        const rem = prev.remainingSeconds - 1;
        const mins = Math.floor(rem / 60);
        const secs = rem % 60;
        const fmt = `${mins}m ${secs}s`;
        return { ...prev, remainingSeconds: rem, formatted: fmt };
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [tunnelTimer?.active, fetchTunnelTimer]);

  useEffect(() => {
    fetchTunnelTimer();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        fetchTunnelTimer();
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchTunnelTimer]);

  // -------------------------------------------------------------
  // Feature 6: Terminal Scroll Tracking ("Jump to Bottom")
  // -------------------------------------------------------------
  useEffect(() => {
    setIsScrolledUp(false);
  }, [activeSessionId]);

  useEffect(() => {
    const handleScrolledUp = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail.isScrolledUp === 'boolean') {
        if (!detail.sessionId || detail.sessionId === activeSessionId) {
          setIsScrolledUp(detail.isScrolledUp);
        }
      }
    };
    window.addEventListener('omniterm:terminal-scrolled-up', handleScrolledUp);
    return () => window.removeEventListener('omniterm:terminal-scrolled-up', handleScrolledUp);
  }, [activeSessionId]);

  const handleJumpToBottom = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('omniterm:scroll-to-bottom', {
        detail: { sessionId: activeSessionId },
      }),
    );
    setIsScrolledUp(false);
  }, [activeSessionId]);

  // -------------------------------------------------------------
  // Feature 2: WebAuthn Biometric & PIN Security Lock
  // -------------------------------------------------------------
  // Auto-lock when hidden in background for autoLockMinutes
  useEffect(() => {
    if (!bioEnabled || autoLockMinutes <= 0) return;
    let hiddenAt = 0;
    const handleVis = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (document.visibilityState === 'visible' && hiddenAt > 0) {
        const elapsed = (Date.now() - hiddenAt) / 60000;
        if (elapsed >= autoLockMinutes) {
          setIsBioLocked(true);
        }
        hiddenAt = 0;
      }
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => document.removeEventListener('visibilitychange', handleVis);
  }, [bioEnabled, autoLockMinutes]);

  const triggerBiometricUnlock = useCallback(async () => {
    try {
      setPinError('');
      if (typeof window === 'undefined' || !window.PublicKeyCredential) {
        throw new Error('WebAuthn không khả dụng');
      }
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const credIdBase64 = localStorage.getItem('omniterm.bioLock.credId');
      const getOptions: CredentialRequestOptions = {
        publicKey: {
          challenge,
          timeout: 60000,
          userVerification: 'preferred',
          allowCredentials: credIdBase64
            ? [{ id: base64ToBuffer(credIdBase64), type: 'public-key' }]
            : undefined,
        },
      };
      const assertion = await navigator.credentials.get(getOptions);
      if (assertion) {
        setIsBioLocked(false);
        setPinInput('');
        setPinError('');
        setNotificationToast({
          title: 'Unlocked',
          message: 'Xác thực sinh trắc học thành công.',
          timestamp: Date.now(),
          type: 'success',
        });
      }
    } catch {
      setPinError('Xác thực sinh trắc học bị hủy hoặc không khớp. Vui lòng thử lại hoặc dùng PIN.');
    }
  }, []);

  const handlePinUnlock = useCallback(async () => {
    if (!pinInput.trim()) return;
    const hash = await sha256(pinInput.trim());
    const storedHash = localStorage.getItem('omniterm.bioLock.pinHash');
    if (storedHash && hash === storedHash) {
      setIsBioLocked(false);
      setPinInput('');
      setPinError('');
      setNotificationToast({
        title: 'Unlocked',
        message: 'Mở khóa bằng mã PIN thành công.',
        timestamp: Date.now(),
        type: 'success',
      });
    } else {
      setPinError('Mã PIN không đúng. Vui lòng kiểm tra lại!');
    }
  }, [pinInput]);

  const handleSavePinSetup = useCallback(async () => {
    if (!setupPinValue || setupPinValue.length < 4) {
      setSetupPinError('Mã PIN cần có ít nhất 4 chữ số');
      return;
    }
    const hash = await sha256(setupPinValue.trim());
    localStorage.setItem('omniterm.bioLock.pinHash', hash);
    localStorage.setItem('omniterm.bioLock.enabled', 'true');
    setBioEnabled(true);
    setShowPinSetupModal(false);
    setSetupPinValue('');
    setSetupPinError('');

    // Attempt WebAuthn registration
    try {
      if (typeof window !== 'undefined' && window.PublicKeyCredential) {
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const cred = (await navigator.credentials.create({
          publicKey: {
            challenge,
            rp: { name: 'OmniTerm Remote' },
            user: {
              id: new Uint8Array([1, 7, 7, 1, 7]),
              name: 'omniterm-user',
              displayName: 'OmniTerm Remote Terminal',
            },
            pubKeyCredParams: [
              { alg: -7, type: 'public-key' },
              { alg: -257, type: 'public-key' },
            ],
            authenticatorSelection: {
              authenticatorAttachment: 'platform',
              userVerification: 'preferred',
            },
            timeout: 60000,
          },
        })) as PublicKeyCredential | null;

        if (cred && cred.rawId) {
          localStorage.setItem('omniterm.bioLock.credId', bufferToBase64(cred.rawId));
        }
      }
    } catch {}

    setNotificationToast({
      title: 'Biometrics Active',
      message: 'Đã kích hoạt bảo mật FaceID / TouchID và mã PIN dự phòng.',
      timestamp: Date.now(),
      type: 'success',
    });
  }, [setupPinValue]);

  const handleDisableBioLock = useCallback(() => {
    localStorage.removeItem('omniterm.bioLock.enabled');
    localStorage.removeItem('omniterm.bioLock.pinHash');
    localStorage.removeItem('omniterm.bioLock.credId');
    setBioEnabled(false);
    setIsBioLocked(false);
    setNotificationToast({
      title: 'Security Disabled',
      message: 'Màn hình khóa bảo vệ đã được gỡ bỏ.',
      timestamp: Date.now(),
      type: 'info',
    });
  }, []);

  // -------------------------------------------------------------
  // Feature 5: PWA Installation & Guidance
  // -------------------------------------------------------------
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).__omniterm_pwa_prompt) {
      setPwaInstallPrompt((window as any).__omniterm_pwa_prompt);
    }
    const handlePwaReady = () => {
      if (typeof window !== 'undefined' && (window as any).__omniterm_pwa_prompt) {
        setPwaInstallPrompt((window as any).__omniterm_pwa_prompt);
      }
    };
    window.addEventListener('omniterm:pwa-installable', handlePwaReady);
    return () => window.removeEventListener('omniterm:pwa-installable', handlePwaReady);
  }, []);

  const handleTriggerPwaInstall = useCallback(async () => {
    if (pwaInstallPrompt) {
      try {
        pwaInstallPrompt.prompt();
        const choice = await pwaInstallPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          setPwaInstallPrompt(null);
          setNotificationToast({
            title: 'Install PWA',
            message: 'Đang cài đặt ứng dụng lên màn hình chính...',
            timestamp: Date.now(),
            type: 'success',
          });
        }
      } catch {
        setShowPwaModal(true);
      }
    } else {
      setShowPwaModal(true);
    }
  }, [pwaInstallPrompt]);

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
      title: 'Approved (y)',
      message: 'Đã xác nhận áp dụng thay đổi vào terminal.',
      timestamp: Date.now(),
      type: 'success',
    });
  };

  const handleDiffReject = () => {
    sendData(getWindow(), 'n\r');
    setShowDiffModal(false);
    setNotificationToast({
      title: 'Rejected (n)',
      message: 'Đã từ chối thay đổi vào terminal.',
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

  // Quick Chips catalog (Developer Keycap style — zero AI slop)
  const CHIPS: ActionChip[] = [
    {
      id: 'diff',
      label: 'diff',
      ariaLabel: 'View git diff',
      variant: 'accent',
      action: openDiffViewer,
    },
    {
      id: 'yes',
      label: 'y',
      ariaLabel: 'Approve (y)',
      variant: 'success',
      action: () => sendData(getWindow(), 'y\r'),
    },
    {
      id: 'no',
      label: 'n',
      ariaLabel: 'Reject (n)',
      variant: 'danger',
      action: () => sendData(getWindow(), 'n\r'),
    },
    {
      id: 'ctrl-c',
      label: '^C',
      ariaLabel: 'Interrupt agent (Ctrl+C)',
      variant: 'danger',
      action: () => sendData(getWindow(), ETX),
    },
    {
      id: 'tab',
      label: 'tab ⇥',
      ariaLabel: 'Tab key',
      action: () => sendDescriptor(getWindow(), { id: 'tab', label: 'Tab', ariaLabel: 'Tab', type: 'bytes', data: TAB }),
    },
    {
      id: 'esc',
      label: 'esc',
      ariaLabel: 'Escape key',
      action: () => sendDescriptor(getWindow(), { id: 'esc', label: 'Esc', ariaLabel: 'Escape', type: 'bytes', data: ESC }),
    },
    {
      id: 'plan',
      label: '/plan',
      ariaLabel: 'Slash plan',
      variant: 'accent',
      action: () => sendData(getWindow(), '/plan '),
    },
    {
      id: 'goal',
      label: '/goal',
      ariaLabel: 'Slash goal',
      variant: 'accent',
      action: () => sendData(getWindow(), '/goal '),
    },
    {
      id: 'agy',
      label: 'agy',
      ariaLabel: 'Start agy',
      action: () => sendData(getWindow(), 'agy\r'),
    },
    {
      id: 'stealth',
      label: 'stealth',
      ariaLabel: 'Dim Mac display',
      action: handleSleepDisplay,
    },
    {
      id: 'lock-ui',
      label: 'lock ui',
      ariaLabel: 'Lock UI with FaceID or PIN',
      action: () => {
        if (!bioEnabled) {
          setShowPinSetupModal(true);
        } else {
          setIsBioLocked(true);
        }
      },
    },
    {
      id: 'reconnect',
      label: 'reconnect',
      ariaLabel: 'Soft-reconnect terminal',
      action: triggerSoftReconnect,
    },
    {
      id: 'health',
      label: 'health',
      ariaLabel: 'System health & telemetry',
      action: () => setShowHealthModal(true),
    },
    ...(!isStandalone
      ? [
          {
            id: 'install-pwa',
            label: 'install',
            ariaLabel: 'Install standalone app',
            variant: 'accent' as const,
            action: handleTriggerPwaInstall,
          },
        ]
      : []),
    {
      id: 'lock',
      label: 'lock tunnel',
      ariaLabel: 'Lock tunnel',
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
            {notificationToast.type === 'success' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            ) : notificationToast.type === 'warning' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            )}
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
            ×
          </button>
        </div>
      )}

      {/* 🔴 NETWORK OFFLINE / RECONNECTING FLOATING BANNER */}
      {connectionStatus !== 'online' && (
        <div
          style={S.networkBanner}
          onClick={triggerSoftReconnect}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: connectionStatus === 'reconnecting' ? '#f59e0b' : '#ef4444',
              display: 'inline-block',
              marginRight: 6,
            }}
          />
          <span>
            {connectionStatus === 'reconnecting'
              ? 'Reconnecting to host…'
              : 'Connection lost · Tap to reconnect'}
          </span>
        </div>
      )}

      {/* ⬇️ FLOATING JUMP TO BOTTOM BUTTON (Feature 6) */}
      {isScrolledUp && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Cuộn xuống cuối terminal"
          style={{
            ...S.jumpToBottomBtn,
            bottom: `calc(${floatingBottom} + 96px)`,
          }}
          onClick={handleJumpToBottom}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>↓</span>
        </button>
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
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15" />
          </svg>
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
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
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
            aria-label="Mở thanh nhập lệnh"
            style={S.fabLauncherBtn}
            onPointerDown={handlePreserveKeyboard(() => setBarOpen(true))}
            onTouchStart={handlePreserveKeyboard(() => setBarOpen(true))}
            onClick={handlePreserveKeyboard(() => setBarOpen(true))}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
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
            <button
              type="button"
              tabIndex={-1}
              style={S.healthPill}
              onClick={() => setShowHealthModal(true)}
              title="Chạm để xem chi tiết tình trạng Mac"
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  background: health?.tunnelActive ? '#22c55e' : '#a1a1aa',
                  boxShadow: health?.tunnelActive ? '0 0 6px rgba(34, 197, 94, 0.6)' : 'none',
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
              {health ? (
                <>
                  <span style={S.healthItem}>
                    {health.battery.hasBattery
                      ? `${health.battery.percent}%${health.battery.chargingState === 'charging' ? '+' : ''}`
                      : 'AC'}
                  </span>
                  <span style={S.healthDot}>·</span>
                  <span style={S.healthItem}>{health.memory.percent}% mem</span>
                  <span style={S.healthDot}>·</span>
                  <span style={S.healthItem}>{health.cpu.percent}% cpu</span>
                  {tunnelTimer?.active && (
                    <>
                      <span style={S.healthDot}>·</span>
                      <span style={{ ...S.healthItem, color: '#38bdf8' }}>
                        ⏱ {tunnelTimer.formatted || `${Math.ceil(tunnelTimer.remainingSeconds / 60)}m`}
                      </span>
                    </>
                  )}
                </>
              ) : (
                <span style={S.healthItem}>
                  mac remote {healthLoading ? '…' : ''}
                </span>
              )}
            </button>

            {/* Top Right Control Strip */}
            <div style={S.controlStrip}>
              {!isStandalone && (
                <button
                  type="button"
                  tabIndex={-1}
                  style={S.controlBtn}
                  onClick={handleTriggerPwaInstall}
                  title="Cài đặt OmniTerm thành Ứng dụng độc lập"
                >
                  install
                </button>
              )}
              <button
                type="button"
                tabIndex={-1}
                style={S.controlBtn}
                onClick={handleSleepDisplay}
                title="Tắt màn hình Mac (Stealth Mode)"
              >
                stealth
              </button>
              <button
                type="button"
                tabIndex={-1}
                style={S.controlBtn}
                onClick={() => {
                  setConfirmSleep(true);
                  setShowHealthModal(true);
                }}
                title="Cho Mac ngủ"
              >
                sleep
              </button>
            </div>
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

          {/* Khung nhập liệu Pill-shaped bo tròn */}
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
              {isListening ? (
                <span style={{ width: 8, height: 8, borderRadius: 2, background: '#ef4444' }} />
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              )}
            </button>

            {/* Ô nhập Textarea */}
            <textarea
              ref={composeRef}
              rows={1}
              placeholder={isListening ? 'Đang lắng nghe...' : 'Nhắn tin cho agy hoặc bấm micro…'}
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

            {/* Nút Gửi tròn (Send button) */}
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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* 💻 MODAL: REMOTE MAC HEALTH & POWER MANAGEMENT (Feature 3) */}
      {showHealthModal && (
        <div style={S.modalOverlay} onClick={() => setShowHealthModal(false)}>
          <div style={S.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <div style={S.modalTitle}>System Telemetry</div>
              <button
                type="button"
                tabIndex={-1}
                style={S.modalCloseBtn}
                onClick={() => setShowHealthModal(false)}
              >
                ×
              </button>
            </div>

            {health ? (
              <div style={S.modalBody}>
                {/* Battery Block */}
                <div style={S.metricBlock}>
                  <div style={S.metricTitle}>
                    {health.battery.hasBattery
                      ? `${health.battery.chargingState === 'charging' ? 'Battery · Charging' : 'Battery · In use'}`
                      : 'Power · AC Direct'}
                  </div>
                  <div style={S.metricValue}>
                    {health.battery.percent}% {health.battery.timeRemaining ? `· ${health.battery.timeRemaining}` : ''}
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
                  <div style={S.metricTitle}>RAM Memory</div>
                  <div style={S.metricValue}>
                    {health.memory.usedGB} GB / {health.memory.totalGB} GB ({health.memory.percent}%)
                  </div>
                  <div style={S.barTrack}>
                    <div
                      style={{
                        ...S.barFill,
                        width: `${health.memory.percent}%`,
                        background: health.memory.percent > 85 ? '#f97316' : '#38bdf8',
                      }}
                    />
                  </div>
                </div>

                {/* CPU & Uptime Block */}
                <div style={S.metricRow}>
                  <div style={{ ...S.metricBlock, flex: 1, marginRight: 8 }}>
                    <div style={S.metricTitle}>CPU Load</div>
                    <div style={S.metricValue}>
                      {health.cpu.percent}% ({health.cpu.cores} cores)
                    </div>
                  </div>
                  <div style={{ ...S.metricBlock, flex: 1 }}>
                    <div style={S.metricTitle}>Uptime</div>
                    <div style={S.metricValue}>{health.uptimeFormatted}</div>
                  </div>
                </div>

                {/* Tunnel Status */}
                <div style={S.metricBlock}>
                  <div style={S.metricTitle}>Reverse Tunnel (GCP VM)</div>
                  <div style={{ ...S.metricValue, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 3.5,
                        background: health.tunnelActive ? '#22c55e' : '#71717a',
                        boxShadow: health.tunnelActive ? '0 0 6px rgba(34, 197, 94, 0.6)' : 'none',
                        display: 'inline-block',
                      }}
                    />
                    <span>{health.tunnelActive ? 'Active · us-west1-b' : 'Inactive · Local Mac'}</span>
                  </div>
                </div>

                {/* Feature 4: Tunnel Lease Timer */}
                <div style={S.metricBlock}>
                  <div style={S.metricTitle}>Tunnel Lease Timer</div>
                  <div style={{ ...S.metricValue, fontSize: 13, marginBottom: 8 }}>
                    {tunnelTimer?.active ? (
                      <span style={{ color: '#38bdf8' }}>
                        Countdown active: <b>{tunnelTimer.formatted || `${Math.ceil(tunnelTimer.remainingSeconds / 60)}m`}</b> remaining
                      </span>
                    ) : (
                      <span style={{ color: '#71717a' }}>No active lease timer (tunnel stays open until manual stop)</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <button
                      type="button"
                      style={S.timerPresetBtn}
                      onClick={() => handleSetTunnelTimer(30)}
                    >
                      30m
                    </button>
                    <button
                      type="button"
                      style={S.timerPresetBtn}
                      onClick={() => handleSetTunnelTimer(60)}
                    >
                      1h
                    </button>
                    <button
                      type="button"
                      style={S.timerPresetBtn}
                      onClick={() => handleSetTunnelTimer(120)}
                    >
                      2h
                    </button>
                    <button
                      type="button"
                      style={S.timerPresetBtn}
                      onClick={() => handleSetTunnelTimer(240)}
                    >
                      4h
                    </button>
                    {tunnelTimer?.active && (
                      <button
                        type="button"
                        style={{ ...S.timerPresetBtn, borderColor: '#ef4444', color: '#f87171' }}
                        onClick={() => handleSetTunnelTimer(0)}
                      >
                        Cancel timer
                      </button>
                    )}
                  </div>
                </div>

                {/* Feature 2: Biometric & PIN Security */}
                <div style={S.metricBlock}>
                  <div style={S.metricTitle}>Biometric & PIN Security</div>
                  <div style={{ ...S.metricValue, fontSize: 13, marginBottom: 8 }}>
                    {bioEnabled ? (
                      <span style={{ color: '#4ade80' }}>
                        Active · Protected with Biometrics & PIN
                      </span>
                    ) : (
                      <span style={{ color: '#71717a' }}>Protection not configured</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {bioEnabled ? (
                      <>
                        <button
                          type="button"
                          style={{
                            ...S.timerPresetBtn,
                            background: 'rgba(239, 68, 68, 0.15)',
                            borderColor: 'rgba(239, 68, 68, 0.3)',
                            color: '#fca5a5',
                          }}
                          onClick={() => {
                            setShowHealthModal(false);
                            setIsBioLocked(true);
                          }}
                        >
                          Lock UI now
                        </button>
                        <button
                          type="button"
                          style={S.timerPresetBtn}
                          onClick={() => setShowPinSetupModal(true)}
                        >
                          Change PIN
                        </button>
                        <button
                          type="button"
                          style={{ ...S.timerPresetBtn, color: '#94a3b8' }}
                          onClick={handleDisableBioLock}
                        >
                          Disable
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        style={{
                          ...S.timerPresetBtn,
                          background: 'rgba(56, 189, 248, 0.12)',
                          borderColor: 'rgba(56, 189, 248, 0.25)',
                          color: '#38bdf8',
                        }}
                        onClick={() => setShowPinSetupModal(true)}
                      >
                        Configure Biometrics / PIN
                      </button>
                    )}
                  </div>
                </div>

                {/* Confirm Sleep Dialog */}
                {confirmSleep ? (
                  <div style={S.confirmBox}>
                    <div style={S.confirmText}>
                      <b>Confirm Sleep Mode?</b>
                      <br />
                      Remote Mac will enter sleep. The reverse tunnel will disconnect until the host wakes up.
                    </div>
                    <div style={S.confirmBtns}>
                      <button
                        type="button"
                        tabIndex={-1}
                        style={S.confirmSleepBtn}
                        onClick={handleSleepMac}
                      >
                        Sleep Mac now
                      </button>
                      <button
                        type="button"
                        tabIndex={-1}
                        style={S.confirmCancelBtn}
                        onClick={() => setConfirmSleep(false)}
                      >
                        Cancel
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
                      Refresh
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      style={{
                        ...S.sleepActionBtn,
                        background: 'rgba(255, 255, 255, 0.05)',
                        borderColor: 'rgba(255, 255, 255, 0.12)',
                        color: '#d4d4d8',
                      }}
                      onClick={() => {
                        handleSleepDisplay();
                        setShowHealthModal(false);
                      }}
                      title="Dim Mac display without suspending background jobs"
                    >
                      Stealth Display
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      style={S.sleepActionBtn}
                      onClick={() => setConfirmSleep(true)}
                    >
                      Sleep Mac
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div style={S.modalLoading}>Checking host telemetry…</div>
            )}
          </div>
        </div>
      )}

      {/* ⚙️ MODAL: SETUP BIOMETRIC & PIN (Feature 2) */}
      {showPinSetupModal && (
        <div style={S.modalOverlay} onClick={() => setShowPinSetupModal(false)}>
          <div style={S.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <div style={S.modalTitle}>Biometric & PIN Setup</div>
              <button
                type="button"
                tabIndex={-1}
                style={S.modalCloseBtn}
                onClick={() => setShowPinSetupModal(false)}
              >
                ×
              </button>
            </div>
            <div style={S.modalBody}>
              <div style={S.metricTitle}>
                Set a numeric PIN (4-8 digits) as backup authentication:
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSavePinSetup();
                }}
                style={{ marginTop: 12 }}
              >
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={8}
                  placeholder="e.g. 123456"
                  value={setupPinValue}
                  onChange={(e) => {
                    setSetupPinValue(e.target.value);
                    setSetupPinError('');
                  }}
                  style={{ ...S.pinInput, width: '100%' }}
                  autoFocus
                />
                {setupPinError && (
                  <div style={{ ...S.pinErrorText, textAlign: 'left', marginTop: 8 }}>
                    {setupPinError}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                  <button
                    type="submit"
                    style={{
                      ...S.sleepActionBtn,
                      background: '#f4f4f5',
                      borderColor: '#ffffff',
                      color: '#090a0f',
                    }}
                  >
                    Enable Protection
                  </button>
                  <button
                    type="button"
                    style={S.refreshBtn}
                    onClick={() => setShowPinSetupModal(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* 🛡️ BIOMETRIC & PIN LOCK FULLSCREEN OVERLAY (Feature 2) */}
      {isBioLocked && (
        <div style={S.bioLockOverlay}>
          <div style={S.bioLockCard}>
            <div style={S.bioLockIcon}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#e4e4e7" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div style={S.bioLockTitle}>OmniTerm Security Shield</div>
            <div style={S.bioLockSubtitle}>
              Remote session is locked. Authenticate using biometrics or backup PIN.
            </div>

            {/* FaceID / TouchID Main Button */}
            <button
              type="button"
              style={S.bioAuthBtn}
              onClick={triggerBiometricUnlock}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8 }}>
                <path d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04A18.06 18.06 0 0 1 5 11c0-4.418 3.582-8 8-8s8 3.582 8 8a17.9 17.9 0 0 1-1.048 6" />
                <path d="M9 11a3 3 0 1 1 6 0c0 1.657-.343 3.234-.969 4.664" />
              </svg>
              Unlock with Biometrics
            </button>

            {/* Divider */}
            <div style={S.bioDividerRow}>
              <div style={S.bioDividerLine} />
              <span style={S.bioDividerText}>or enter backup PIN</span>
              <div style={S.bioDividerLine} />
            </div>

            {/* PIN Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handlePinUnlock();
              }}
              style={S.pinForm}
            >
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                placeholder="PIN"
                value={pinInput}
                onChange={(e) => {
                  setPinInput(e.target.value);
                  setPinError('');
                }}
                style={S.pinInput}
              />
              <button type="submit" style={S.pinSubmitBtn}>
                Unlock
              </button>
            </form>

            {pinError && <div style={S.pinErrorText}>{pinError}</div>}
          </div>
        </div>
      )}

      {/* 📲 MODAL: PWA INSTALLATION GUIDE (Feature 5) */}
      {showPwaModal && (
        <div style={S.modalOverlay} onClick={() => setShowPwaModal(false)}>
          <div style={S.modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <div style={S.modalTitle}>Install OmniTerm PWA</div>
              <button
                type="button"
                tabIndex={-1}
                style={S.modalCloseBtn}
                onClick={() => setShowPwaModal(false)}
              >
                ×
              </button>
            </div>
            <div style={S.modalBody}>
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <img
                  src="/apple-touch-icon.png"
                  alt="OmniTerm Icon"
                  style={{ width: 56, height: 56, borderRadius: 14, boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}
                />
                <div style={{ fontSize: 15, fontWeight: 600, color: '#f8fafc', marginTop: 10 }}>
                  OmniTerm Remote Agent
                </div>
                <div style={{ fontSize: 12, color: '#71717a' }}>
                  Standalone fullscreen workspace without browser URL bar
                </div>
              </div>

              {pwaInstallPrompt && (
                <div style={{ textAlign: 'center', margin: '14px 0' }}>
                  <button
                    type="button"
                    style={{ ...S.bioAuthBtn, background: '#f4f4f5', color: '#090a0f' }}
                    onClick={handleTriggerPwaInstall}
                  >
                    Install to Home Screen
                  </button>
                </div>
              )}

              {/* Instructions */}
              <div style={{ background: 'rgba(255, 255, 255, 0.04)', borderRadius: 12, padding: 12, marginBottom: 10, border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                <div style={{ fontWeight: 600, color: '#e4e4e7', fontSize: 12, marginBottom: 4 }}>
                  iOS Safari
                </div>
                <div style={{ fontSize: 12, color: '#a1a1aa', lineHeight: 1.5 }}>
                  1. Open in <b>Safari</b>.<br />
                  2. Tap <b>Share</b> in Safari bottom bar.<br />
                  3. Select <b>Add to Home Screen</b>.<br />
                  4. Tap <b>Add</b>.
                </div>
              </div>

              <div style={{ background: 'rgba(255, 255, 255, 0.04)', borderRadius: 12, padding: 12, border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                <div style={{ fontWeight: 600, color: '#e4e4e7', fontSize: 12, marginBottom: 4 }}>
                  Android Chrome / Samsung Internet
                </div>
                <div style={{ fontSize: 12, color: '#a1a1aa', lineHeight: 1.5 }}>
                  1. Tap <b>⋮</b> (menu) at top-right.<br />
                  2. Select <b>Install App</b> or <b>Add to Home Screen</b>.
                </div>
              </div>

              <div style={{ marginTop: 16 }}>
                <button
                  type="button"
                  style={S.refreshBtn}
                  onClick={() => setShowPwaModal(false)}
                >
                  Dismiss
                </button>
              </div>
            </div>
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
                <span style={S.diffTitle}>git diff</span>
                {diffData && (
                  <span style={S.diffStatsBadge}>
                    <span style={{ color: '#4ade80' }}>+{diffData.summary.additions}</span>{' '}
                    <span style={{ color: '#f87171' }}>-{diffData.summary.deletions}</span>{' '}
                    <span style={{ color: '#71717a' }}>({diffData.files.length} files)</span>
                  </span>
                )}
              </div>
              <div style={S.diffHeaderRight}>
                <button
                  type="button"
                  tabIndex={-1}
                  style={S.diffRefreshBtn}
                  onClick={fetchDiff}
                  title="Reload diff"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                    <path d="M16 21h5v-5" />
                  </svg>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  style={S.diffCloseBtn}
                  onClick={() => setShowDiffModal(false)}
                >
                  ×
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
                <div style={S.diffEmptyState}>Loading git diff…</div>
              ) : !diffData || !diffData.isGit ? (
                <div style={S.diffEmptyState}>Workspace is not a Git repository.</div>
              ) : diffData.files.length === 0 ? (
                <div style={S.diffEmptyState}>
                  Working tree clean. No changes detected.
                </div>
              ) : activeDiffFile ? (
                <div style={S.diffCodeContainer}>
                  <div style={S.diffFilePathHeader}>
                    <b>{activeDiffFile.file}</b> ({activeDiffFile.status})
                  </div>
                  {activeDiffFile.lines.length === 0 ? (
                    <div style={S.diffFileUntracked}>
                      Untracked file.
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
                approve (y)
              </button>
              <button
                type="button"
                tabIndex={-1}
                style={S.diffRejectBtn}
                onClick={handleDiffReject}
              >
                reject (n)
              </button>
              <button
                type="button"
                tabIndex={-1}
                style={S.diffDismissBtn}
                onClick={() => setShowDiffModal(false)}
              >
                close
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
  // Navigation Pill (▲ / ▼) — Minimal Obsidian Keycap
  navPillContainer: {
    position: 'fixed',
    right: 12,
    zIndex: BAR_Z + 10,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: 36,
    borderRadius: 18,
    background: 'rgba(20, 22, 28, 0.92)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45), 0 2px 4px rgba(0, 0, 0, 0.25)',
    overflow: 'hidden',
    transition: 'bottom 0.2s cubic-bezier(0.2, 0, 0, 1)',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'manipulation',
  },
  navPillBtnTop: {
    width: '100%',
    height: 36,
    border: 'none',
    background: 'transparent',
    color: '#a1a1aa',
    fontSize: 13,
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
    width: '60%',
    height: 1,
    background: 'rgba(255, 255, 255, 0.08)',
  },
  navPillBtnBottom: {
    width: '100%',
    height: 36,
    border: 'none',
    background: 'transparent',
    color: '#a1a1aa',
    fontSize: 13,
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

  // FAB Launcher (Clean Terminal Prompt Icon)
  fabLauncher: {
    position: 'fixed',
    left: 12,
    zIndex: BAR_Z + 10,
  },
  fabLauncherBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    background: 'rgba(20, 22, 28, 0.92)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#e4e4e7',
    outline: 'none',
  },

  // Developer Bottom Input Bar
  chatBarContainer: {
    position: 'fixed',
    left: 0,
    right: 0,
    zIndex: BAR_Z,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '6px 10px calc(6px + env(safe-area-inset-bottom, 0px))',
    background: 'rgba(13, 15, 20, 0.97)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    borderTop: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.6)',
    transition: 'bottom 0.2s cubic-bezier(0.2, 0, 0, 1)',
  },

  // Top Status Bar: Telemetry & Controls
  topStatusBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 2px',
  },
  healthPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 8px',
    height: 22,
    borderRadius: 5,
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.07)',
    fontSize: 11,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontVariantNumeric: 'tabular-nums',
    color: '#a1a1aa',
    cursor: 'pointer',
    outline: 'none',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
  },
  healthItem: {
    fontWeight: 500,
  },
  healthDot: {
    opacity: 0.35,
    margin: '0 1px',
  },
  controlStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  controlBtn: {
    height: 22,
    padding: '0 8px',
    borderRadius: 5,
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.07)',
    color: '#a1a1aa',
    fontSize: 11,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontWeight: 500,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
    transition: 'all 0.15s ease',
  },
  sleepShortcutBtn: {
    height: 22,
    padding: '0 8px',
    borderRadius: 5,
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.25)',
    color: '#f87171',
    fontSize: 11,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontWeight: 500,
    cursor: 'pointer',
    outline: 'none',
  },

  // Hàng Quick Chips cuộn ngang — Monospace Keycaps
  chipsRow: {
    display: 'flex',
    gap: 5,
    overflowX: 'auto',
    overflowY: 'hidden',
    paddingBottom: 2,
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
    touchAction: 'pan-x',
  },
  chipBase: {
    flexShrink: 0,
    padding: '4px 9px',
    borderRadius: 6,
    background: 'rgba(255, 255, 255, 0.05)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
    color: '#d4d4d8',
    fontSize: 11.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
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
    background: 'rgba(34, 197, 94, 0.1)',
    border: '1px solid rgba(34, 197, 94, 0.25)',
    color: '#4ade80',
  },
  chip_danger: {
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.25)',
    color: '#f87171',
  },
  chip_accent: {
    background: 'rgba(56, 189, 248, 0.1)',
    border: '1px solid rgba(56, 189, 248, 0.25)',
    color: '#38bdf8',
  },
  chip_warning: {
    background: 'rgba(234, 179, 8, 0.1)',
    border: '1px solid rgba(234, 179, 8, 0.25)',
    color: '#fbbf24',
  },

  // Khung nhập Prompt dạng Squircle
  promptPill: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 6px',
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 14,
    boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.3)',
  },
  micBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.06)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: '#a1a1aa',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    outline: 'none',
  },
  micListening: {
    width: 32,
    height: 32,
    borderRadius: 8,
    border: '1px solid rgba(239, 68, 68, 0.3)',
    background: 'rgba(239, 68, 68, 0.15)',
    color: '#ef4444',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    outline: 'none',
  },
  promptInput: {
    flex: 1,
    minHeight: 22,
    maxHeight: 120,
    padding: '5px 8px',
    border: 'none',
    background: 'transparent',
    color: '#f4f4f5',
    fontSize: 13.5,
    lineHeight: '20px',
    resize: 'none',
    outline: 'none',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  sendBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    border: 'none',
    background: '#f4f4f5',
    color: '#090a0f',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.3)',
    outline: 'none',
  },
  hideBtn: {
    width: 26,
    height: 26,
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: '#71717a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    outline: 'none',
  },

  // Toast Notification Banner — Obsidian Card
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
    borderRadius: 10,
    background: 'rgba(18, 20, 26, 0.96)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
    animation: 'slideDown 0.3s ease-out',
  },
  toastIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  toastBody: {
    flex: 1,
    minWidth: 0,
  },
  toastTitle: {
    fontSize: 12.5,
    fontWeight: 600,
    color: '#f4f4f5',
  },
  toastMessage: {
    fontSize: 11.5,
    color: '#a1a1aa',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  toastClose: {
    border: 'none',
    background: 'transparent',
    color: '#71717a',
    fontSize: 16,
    cursor: 'pointer',
    padding: 4,
    lineHeight: 1,
  },

  // Network Banner — Minimal Status Dot
  networkBanner: {
    position: 'fixed',
    top: 14,
    left: 20,
    right: 20,
    zIndex: BAR_Z + 90,
    padding: '6px 12px',
    borderRadius: 8,
    background: 'rgba(24, 26, 32, 0.95)',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    color: '#f4f4f5',
    fontSize: 11,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    cursor: 'pointer',
  },

  // Modal Styles (Obsidian Developer Surface)
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
    borderRadius: 14,
    background: '#101216',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 24px 48px rgba(0, 0, 0, 0.8)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  },
  modalTitle: {
    fontSize: 13.5,
    fontWeight: 600,
    color: '#f4f4f5',
  },
  modalCloseBtn: {
    border: 'none',
    background: 'transparent',
    color: '#71717a',
    fontSize: 16,
    cursor: 'pointer',
    lineHeight: 1,
  },
  modalBody: {
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  metricBlock: {
    padding: '10px 12px',
    borderRadius: 8,
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(255, 255, 255, 0.05)',
  },
  metricRow: {
    display: 'flex',
  },
  metricTitle: {
    fontSize: 11,
    color: '#71717a',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 13,
    fontWeight: 500,
    color: '#f4f4f5',
    fontVariantNumeric: 'tabular-nums',
  },
  barTrack: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    background: 'rgba(255, 255, 255, 0.08)',
    marginTop: 6,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },
  modalActions: {
    display: 'flex',
    gap: 8,
    marginTop: 4,
  },
  refreshBtn: {
    flex: 1,
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.1)',
    background: 'rgba(255, 255, 255, 0.05)',
    color: '#e4e4e7',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    outline: 'none',
  },
  sleepActionBtn: {
    flex: 1,
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid rgba(239, 68, 68, 0.25)',
    background: 'rgba(239, 68, 68, 0.12)',
    color: '#f87171',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    outline: 'none',
  },
  confirmBox: {
    padding: '12px',
    borderRadius: 8,
    background: 'rgba(239, 68, 68, 0.08)',
    border: '1px solid rgba(239, 68, 68, 0.25)',
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
    borderRadius: 6,
    border: 'none',
    background: '#ef4444',
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    outline: 'none',
  },
  confirmCancelBtn: {
    padding: '8px 14px',
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.12)',
    background: 'transparent',
    color: '#e4e4e7',
    fontSize: 12,
    cursor: 'pointer',
    outline: 'none',
  },
  modalLoading: {
    padding: 24,
    textAlign: 'center',
    color: '#71717a',
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
  },

  // Diff Modal Styles
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
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    background: '#101216',
    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
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
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    background: '#14161f',
  },
  diffHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  diffTitle: {
    fontSize: 13.5,
    fontWeight: 600,
    color: '#f4f4f5',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  diffStatsBadge: {
    fontSize: 11,
    fontWeight: 500,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontVariantNumeric: 'tabular-nums',
    background: 'rgba(255, 255, 255, 0.06)',
    padding: '2px 6px',
    borderRadius: 4,
  },
  diffHeaderRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  diffRefreshBtn: {
    border: 'none',
    background: 'transparent',
    color: '#71717a',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  diffCloseBtn: {
    border: 'none',
    background: 'transparent',
    color: '#71717a',
    fontSize: 18,
    cursor: 'pointer',
    lineHeight: 1,
    padding: 4,
  },
  diffFileTabs: {
    display: 'flex',
    gap: 4,
    padding: '6px 12px',
    background: '#14161f',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
  },
  diffFileTab: {
    flexShrink: 0,
    padding: '3px 8px',
    borderRadius: 5,
    border: '1px solid rgba(255, 255, 255, 0.06)',
    background: '#101216',
    color: '#71717a',
    fontSize: 11,
    fontFamily: 'ui-monospace, monospace',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
  diffFileTabActive: {
    flexShrink: 0,
    padding: '3px 8px',
    borderRadius: 5,
    border: '1px solid rgba(56, 189, 248, 0.3)',
    background: 'rgba(56, 189, 248, 0.1)',
    color: '#38bdf8',
    fontSize: 11,
    fontFamily: 'ui-monospace, monospace',
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
    background: '#0d0f14',
  },
  diffEmptyState: {
    padding: '40px 20px',
    textAlign: 'center',
    color: '#71717a',
    fontSize: 13,
    fontFamily: 'ui-monospace, monospace',
  },
  diffCodeContainer: {
    paddingBottom: 20,
  },
  diffFilePathHeader: {
    padding: '6px 12px',
    background: '#14161f',
    color: '#d4d4d8',
    fontSize: 11.5,
    fontFamily: 'ui-monospace, monospace',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  },
  diffFileUntracked: {
    padding: '20px',
    color: '#71717a',
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
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
    color: '#a1a1aa',
    padding: '0 4px',
  },
  diffLineAdd: {
    display: 'flex',
    background: 'rgba(34, 197, 94, 0.1)',
    color: '#4ade80',
    borderLeft: '2px solid #22c55e',
    padding: '0 4px 0 2px',
  },
  diffLineDel: {
    display: 'flex',
    background: 'rgba(239, 68, 68, 0.1)',
    color: '#f87171',
    borderLeft: '2px solid #ef4444',
    padding: '0 4px 0 2px',
  },
  diffLineHeader: {
    display: 'flex',
    background: 'rgba(56, 189, 248, 0.08)',
    color: '#38bdf8',
    padding: '2px 4px',
    fontSize: 10,
    fontFamily: 'ui-monospace, monospace',
  },
  diffGutter: {
    width: 32,
    color: '#52525b',
    textAlign: 'right',
    paddingRight: 8,
    flexShrink: 0,
    userSelect: 'none',
    fontVariantNumeric: 'tabular-nums',
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
    background: '#14161f',
    borderTop: '1px solid rgba(255, 255, 255, 0.06)',
  },
  diffApproveBtn: {
    flex: 2,
    padding: '9px',
    borderRadius: 8,
    border: 'none',
    background: '#22c55e',
    color: '#052e16',
    fontSize: 12.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontWeight: 600,
    cursor: 'pointer',
    outline: 'none',
  },
  diffRejectBtn: {
    flex: 2,
    padding: '9px',
    borderRadius: 8,
    border: 'none',
    background: '#ef4444',
    color: '#ffffff',
    fontSize: 12.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontWeight: 600,
    cursor: 'pointer',
    outline: 'none',
  },
  diffDismissBtn: {
    flex: 1,
    padding: '9px',
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: '#a1a1aa',
    fontSize: 12.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    cursor: 'pointer',
    outline: 'none',
  },

  // Jump to Bottom Button — Dark Obsidian Keycap
  jumpToBottomBtn: {
    position: 'fixed',
    right: 12,
    zIndex: BAR_Z + 12,
    width: 36,
    height: 36,
    borderRadius: 18,
    background: 'rgba(20, 22, 28, 0.92)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
    color: '#e4e4e7',
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

  // Lease Timer Preset Button
  timerPresetBtn: {
    padding: '5px 10px',
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: '#d4d4d8',
    fontSize: 11.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontWeight: 500,
    cursor: 'pointer',
    outline: 'none',
    WebkitTapHighlightColor: 'transparent',
  },

  // Biometric & PIN Lock Fullscreen Overlay
  bioLockOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 999999,
    background: 'rgba(9, 10, 15, 0.97)',
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  bioLockCard: {
    width: '100%',
    maxWidth: 360,
    background: '#101216',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 16,
    padding: 24,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.8)',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  bioLockIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  bioLockTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: '#f4f4f5',
    marginBottom: 6,
    letterSpacing: -0.2,
  },
  bioLockSubtitle: {
    fontSize: 12,
    color: '#71717a',
    lineHeight: 1.5,
    marginBottom: 20,
  },
  bioAuthBtn: {
    width: '100%',
    height: 44,
    borderRadius: 8,
    border: 'none',
    background: '#f4f4f5',
    color: '#090a0f',
    fontSize: 13,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
    outline: 'none',
    WebkitTapHighlightColor: 'transparent',
  },
  bioDividerRow: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    margin: '18px 0',
  },
  bioDividerLine: {
    flex: 1,
    height: 1,
    background: 'rgba(255, 255, 255, 0.08)',
  },
  bioDividerText: {
    padding: '0 10px',
    fontSize: 11,
    color: '#52525b',
    fontFamily: 'ui-monospace, monospace',
  },
  pinForm: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  pinInput: {
    width: '100%',
    height: 42,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.1)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: '#ffffff',
    fontSize: 16,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    textAlign: 'center',
    letterSpacing: 4,
    outline: 'none',
    boxSizing: 'border-box',
  },
  pinSubmitBtn: {
    width: '100%',
    height: 40,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.12)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#f4f4f5',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    outline: 'none',
  },
  pinErrorText: {
    marginTop: 10,
    color: '#ef4444',
    fontSize: 11.5,
    lineHeight: 1.4,
  },
};
