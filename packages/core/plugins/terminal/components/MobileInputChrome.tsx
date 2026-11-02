'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

interface Props {
  /** Accessor for the active terminal iframe's contentWindow (lazy: read at send time). */
  getWindow: () => Window | null;
  /** Id of the active terminal session. */
  activeSessionId: string | null;
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
 *  - STRICT NO-KEYBOARD TRIGGER on navigation & chip actions.
 */
export default function MobileInputChrome({ getWindow, activeSessionId }: Props) {
  const kbInset = useKeyboardInset();
  const [isListening, setIsListening] = useState(false);
  const [barOpen, setBarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('omniterm.mobileBar.open') !== 'false';
    } catch {
      return true;
    }
  });

  const composeRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const topBtnRef = useRef<HTMLButtonElement>(null);
  const bottomBtnRef = useRef<HTMLButtonElement>(null);

  const isComposingRef = useRef(false);
  const isInteractingRef = useRef(false);
  const lastActionTime = useRef<number>(0);

  // Native touch & pointer event guard on the navigation pill buttons:
  // Intercepts events in the capture/target phase with { passive: false }
  // to prevent mobile browser from dropping virtual keyboard focus.
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
  }, [barOpen, kbInset, isListening]);

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
      // Re-assert focus immediately and in next tick to keep iOS/Android keyboard open
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
      // Dismiss keyboard after sending so user has full view of response
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

  // Danh mục Quick Chips mô phỏng phong cách ChatGPT / Gemini
  const CHIPS: ActionChip[] = [
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
    ? `calc(${kbInset}px + 120px + env(safe-area-inset-bottom, 0px))`
    : `calc(${kbInset}px + 20px + env(safe-area-inset-bottom, 0px))`;

  return (
    <>
      {/* 🕹️ FLOATING NAVIGATION PILL (▲ / ▼) — Kiểu ChatGPT Floating Button */}
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
          {/* Hàng Quick Chips cuộn ngang */}
          <div style={S.chipsRow}>
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
                  onPointerDown={handlePreserveKeyboard(chip.action)}
                  onTouchStart={handlePreserveKeyboard(chip.action)}
                  onClick={handlePreserveKeyboard(chip.action)}
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

            {/* Ô nhập Textarea (chỉ khi chạm vào đây bàn phím mới bật) */}
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
    </>
  );
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
    height: 98,
    borderRadius: 24,
    background: 'rgba(28, 28, 30, 0.82)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.16)',
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
    transition: 'bottom 0.2s ease',
    overflow: 'hidden',
  },
  navPillBtnTop: {
    flex: 1,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: '#007aff',
    fontSize: 17,
    fontWeight: 'bold',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'manipulation',
  },
  navPillDivider: {
    width: '75%',
    height: 1,
    background: 'rgba(255, 255, 255, 0.12)',
  },
  navPillBtnBottom: {
    flex: 1,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: '#007aff',
    fontSize: 17,
    fontWeight: 'bold',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'manipulation',
  },

  // 🔘 Floating Action Button khi thu gọn thanh chat
  fabLauncher: {
    position: 'fixed',
    left: 14,
    zIndex: BAR_Z,
  },
  fabLauncherBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    background: 'rgba(28, 28, 30, 0.85)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(255, 255, 255, 0.18)',
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
    color: '#fff',
    fontSize: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    touchAction: 'manipulation',
  },

  // 💬 Bottom Chat Input Container (ChatGPT Style)
  chatBarContainer: {
    position: 'fixed',
    left: 0,
    right: 0,
    zIndex: BAR_Z,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '8px 12px',
    paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
    background: 'rgba(20, 20, 22, 0.88)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
    boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.5)',
  },

  // Hàng Chip hành động cuộn ngang
  chipsRow: {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    whiteSpace: 'nowrap',
    WebkitOverflowScrolling: 'touch',
    paddingBottom: 2,
    scrollbarWidth: 'none',
  },
  chipBase: {
    flex: '0 0 auto',
    height: 32,
    padding: '0 12px',
    borderRadius: 16,
    fontSize: 13,
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255, 255, 255, 0.08)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    color: '#e5e5e7',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'manipulation',
  },
  chip_success: {
    background: 'rgba(52, 199, 89, 0.18)',
    borderColor: '#34c759',
    color: '#34c759',
    fontWeight: 600,
  },
  chip_danger: {
    background: 'rgba(255, 59, 48, 0.18)',
    borderColor: '#ff3b30',
    color: '#ff453a',
    fontWeight: 600,
  },
  chip_accent: {
    background: 'rgba(10, 132, 255, 0.18)',
    borderColor: '#0a84ff',
    color: '#0a84ff',
    fontWeight: 600,
  },
  chip_warning: {
    background: 'rgba(255, 159, 10, 0.18)',
    borderColor: '#ff9f0a',
    color: '#ffd60a',
  },

  // Khung nhập liệu Pill-shaped
  promptPill: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 8,
    padding: '4px 6px 4px 8px',
    borderRadius: 24,
    background: 'rgba(38, 38, 42, 0.95)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    boxShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.2)',
  },
  promptInput: {
    flex: 1,
    minWidth: 0,
    height: 38,
    minHeight: 38,
    maxHeight: 120,
    resize: 'none',
    fontSize: 15,
    lineHeight: '20px',
    padding: '9px 4px 7px 4px',
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: '#ffffff',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  micBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: 'transparent',
    border: 'none',
    color: '#8e8e93',
    fontSize: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    marginBottom: 1,
    touchAction: 'manipulation',
  },
  micListening: {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: 'rgba(255, 59, 48, 0.25)',
    border: '1px solid #ff3b30',
    color: '#ff453a',
    fontSize: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    marginBottom: 1,
    touchAction: 'manipulation',
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: '#007aff',
    border: 'none',
    color: '#ffffff',
    fontSize: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    marginBottom: 1,
    boxShadow: '0 2px 8px rgba(0, 122, 255, 0.4)',
    touchAction: 'manipulation',
  },
  hideBtn: {
    width: 28,
    height: 36,
    background: 'transparent',
    border: 'none',
    color: '#636366',
    fontSize: 18,
    fontWeight: 'bold',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    marginBottom: 1,
    paddingRight: 4,
    touchAction: 'manipulation',
  },
};
