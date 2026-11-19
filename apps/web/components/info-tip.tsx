'use client';

import { Info } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const WIDTH = 288;
const EDGE = 16;
const GAP = 8;

interface Placement {
  left: number;
  width: number;
  /** Below the icon, or above it when the icon sits low on the screen. */
  top?: number;
  bottom?: number;
}

/**
 * An info icon that explains a term in a few sentences. A mouse shows it on hover and
 * the keyboard on focus; a tap or click keeps it open until the next tap elsewhere,
 * a scroll or Escape. The text stays in the page as the button's description, so a
 * screen reader reads it without opening anything.
 */
export function InfoTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [place, setPlace] = useState<Placement | null>(null);
  const open = hover || focus || pinned;

  const close = useCallback(() => {
    setHover(false);
    setFocus(false);
    setPinned(false);
  }, []);

  // Fixed to the viewport, so a table cell or a narrow column never clips it.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - EDGE * 2);
    const left = Math.min(
      Math.max(EDGE, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - EDGE,
    );
    const below = rect.bottom < window.innerHeight * 0.6;
    setPlace(
      below
        ? { left, width, top: rect.bottom + GAP }
        : { left, width, bottom: window.innerHeight - rect.top + GAP },
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !bubble.current?.contains(target)) close();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onPointerEnter={(event) => event.pointerType === 'mouse' && setHover(true)}
        onPointerLeave={(event) => event.pointerType === 'mouse' && setHover(false)}
        onFocus={(event) => event.currentTarget.matches(':focus-visible') && setFocus(true)}
        onBlur={() => {
          setFocus(false);
          setPinned(false);
        }}
        onClick={() => setPinned((value) => !value)}
        className={cn(
          '-my-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-expanded:text-foreground',
          className,
        )}
      >
        <Info aria-hidden className="size-4" />
      </button>
      <span
        ref={bubble}
        id={id}
        role="tooltip"
        hidden={!open || !place}
        style={place ?? undefined}
        className="fixed z-50 block rounded-lg border border-input bg-popover px-3 py-2.5 text-left text-sm leading-relaxed font-normal whitespace-normal text-popover-foreground shadow-lg shadow-black/40"
      >
        {children}
      </span>
    </>
  );
}
