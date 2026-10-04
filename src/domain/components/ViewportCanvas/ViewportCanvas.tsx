import { useEffect, useId, useRef } from 'react';

import { Viewport } from '@viewport/index';

import { CursorMenu } from '../CursorMenu/CursorMenu';
import { DeleteMenu } from '../DeleteMenu/DeleteMenu';
import { ViewAxes } from '../ViewAxes/ViewAxes';

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
  const guideId = useId();

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
    // A region of its own, named and described, so a screen reader arriving on
    // it hears what it is and how it is steered rather than meeting a blank
    // canvas. What it shows has no text to read: the outliner and the status
    // bar say what is in the scene and what just happened to it.
    <div
      className="viewport-canvas"
      ref={containerRef}
      role="region"
      aria-label="Viewport"
      aria-describedby={guideId}
    >
      <p id={guideId} className="viewport-canvas__guide">
        The 3D view of the scene. Click or tap to select, drag to select a region. Middle-drag
        orbits, Shift and middle-drag pans, the wheel zooms. On a touch screen, pinch to zoom, slide
        two fingers to pan, twist them to turn the view, and drag the axis widget in the corner to
        orbit. A long press opens the 3D cursor menu. Every tool also has a key: Shift and question
        mark lists them.
      </p>
      <canvas className="viewport-canvas__surface" ref={canvasRef} aria-hidden="true" />
      <div className="viewport-canvas__marquee" ref={overlayRef} />
      <ViewAxes />
      <CursorMenu />
      <DeleteMenu />
    </div>
  );
}
