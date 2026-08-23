import { useEffect, useRef } from 'react';

import { Viewport } from '@viewport/index';

import './ViewportCanvas.scss';

/**
 * Mounts the Three.js viewport once and never re-renders it.
 *
 * This component deliberately has no props and no state: everything the
 * viewport needs it reads from the store itself, which is what keeps React out
 * of the per-frame path.
 */
export function ViewportCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const container = containerRef.current;
    if (!canvas || !overlay || !container) return;

    const viewport = new Viewport(canvas, overlay);
    const observer = new ResizeObserver(() => viewport.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      viewport.dispose();
    };
  }, []);

  return (
    <div className="viewport-canvas" ref={containerRef}>
      <canvas className="viewport-canvas__surface" ref={canvasRef} />
      <div className="viewport-canvas__marquee" ref={overlayRef} />
    </div>
  );
}
