'use client';

import { useEffect, useRef, useState } from 'react';

const FRAME_INTERVAL_MS = 1000 / 15;
const MOTION_SPEED = 1.75;
const POINTER_RADIUS = 144;
const POINTER_PUSH = 36;

/** Decorative signal contours, not a visualization of market activity. */
export function AsciiBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(0);
  const pointerRef = useRef({x: 0, y: 0, targetX: 0, targetY: 0, strength: 0, targetStrength: 0});
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    try { setPaused(localStorage.getItem('thesis-background-paused') === 'true'); } catch { /* Storage is optional. */ }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = pointerRef.current;
    let width = 0, height = 0, frame = 0, previous = 0;
    const cellWidth = 12, cellHeight = 18;
    // Fixed-width glyphs are drawn in rows, rather than thousands of DOM nodes.
    const draw = () => {
      context.clearRect(0, 0, width, height);
      context.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      context.textBaseline = 'top';
      context.letterSpacing = '0px';
      context.letterSpacing = `${cellWidth - context.measureText('.').width}px`;
      const columns = Math.ceil(width / cellWidth);
      const rows = Math.ceil(height / cellHeight);
      const glyphs = ['.', ':', '+'] as const;
      const colors = ['rgba(175,184,197,.10)', 'rgba(175,184,197,.17)', 'rgba(175,184,197,.27)'] as const;
      for (let row = 0; row < rows; row++) {
        const y = row * cellHeight;
        const layers: [string, string, string] = ['', '', ''];
        for (let column = 0; column < columns; column++) {
          const x = column * cellWidth;
          const time = phaseRef.current;
          const wave = Math.sin(x * .009 + y * .006 + Math.sin(y * .008 - time * .13) * 1.6 + time * .09);
          const contour = Math.pow(1 - Math.abs(wave), 3);
          // A quiet reading zone in the center; more definition at the margins.
          const edge = Math.min(1, Math.abs(x / width - .54) * 2.5);
          const strength = contour * (.30 + edge * .70);
          const band = strength > .62 ? 2 : strength > .28 ? 1 : strength > .09 ? 0 : -1;
          let displaced = false;
          if (band !== -1 && pointer.strength > .005) {
            const dx = x + cellWidth / 2 - pointer.x;
            const dy = y + cellHeight / 2 - pointer.y;
            const distance = Math.hypot(dx, dy);
            if (distance < POINTER_RADIUS) {
              const push = Math.pow(1 - distance / POINTER_RADIUS, 2) * POINTER_PUSH * pointer.strength;
              const directionX = distance > .1 ? dx / distance : Math.cos(column + row);
              const directionY = distance > .1 ? dy / distance : Math.sin(column + row);
              context.fillStyle = colors[band];
              context.fillText(glyphs[band], x + directionX * push, y + directionY * push);
              displaced = true;
            }
          }
          // Keep unaffected glyphs batched into rows; only the small cursor field is drawn individually.
          for (const layer of [0, 1, 2] as const) layers[layer] += !displaced && band === layer ? glyphs[layer] : ' ';
        }
        for (const layer of [0, 1, 2] as const) {
          context.fillStyle = colors[layer];
          context.fillText(layers[layer], 0, y);
        }
      }
    };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
    const tick = (now: number) => {
      if (previous === 0 || now - previous >= FRAME_INTERVAL_MS) {
        const elapsed = previous === 0 ? FRAME_INTERVAL_MS : Math.min(now - previous, 200);
        if (previous !== 0) phaseRef.current += Math.min(now - previous, 200) / 1000 * MOTION_SPEED;
        const follow = 1 - Math.exp(-elapsed / 100);
        pointer.x += (pointer.targetX - pointer.x) * follow;
        pointer.y += (pointer.targetY - pointer.y) * follow;
        pointer.strength += (pointer.targetStrength - pointer.strength) * (1 - Math.exp(-elapsed / 160));
        previous = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      stop();
      if (motion.matches || document.hidden) pointer.strength = pointer.targetStrength = 0;
      draw();
      if (!paused && !motion.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const resize = () => {
      // Bound the backing store and draw work on ultrawide screens.
      width = Math.min(window.innerWidth, 2160);
      height = Math.min(window.innerHeight, 1440);
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    };
    const observer = new ResizeObserver(resize);
    const move = (event: PointerEvent) => {
      if (paused || motion.matches || event.pointerType === 'touch') return;
      pointer.targetX = event.clientX * width / window.innerWidth;
      pointer.targetY = event.clientY * height / window.innerHeight;
      if (pointer.strength < .005) {
        pointer.x = pointer.targetX;
        pointer.y = pointer.targetY;
      }
      pointer.targetStrength = 1;
    };
    const leave = () => { pointer.targetStrength = 0; };
    const exit = (event: PointerEvent) => { if (!event.relatedTarget) leave(); };
    observer.observe(canvas);
    window.addEventListener('pointermove', move, {passive: true});
    window.addEventListener('pointerout', exit, {passive: true});
    window.addEventListener('blur', leave);
    window.addEventListener('resize', resize);
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    resize();
    sync();
    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerout', exit);
      window.removeEventListener('blur', leave);
      window.removeEventListener('resize', resize);
      motion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [paused]);

  function toggle() {
    const next = !paused;
    setPaused(next);
    try { localStorage.setItem('thesis-background-paused', String(next)); } catch { /* Keep the local control usable. */ }
  }

  return (
    <>
      <canvas ref={canvasRef} className="ascii-background" aria-hidden="true" />
      <button
        type="button"
        className="ascii-motion-control"
        aria-label={paused ? 'Resume background animation' : 'Pause background animation'}
        aria-pressed={paused}
        onClick={toggle}
      >
        <span aria-hidden="true">{paused ? '[ > ]' : '[ II ]'}</span>
        <span>{paused ? 'Still' : 'Motion'}</span>
      </button>
    </>
  );
}
