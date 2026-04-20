/**
 * Draggable, resizable, closable floating panel (portal to body).
 * Modeled on coronary SnakeView but with drag + resize support.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  initialWidth?: number;
  initialHeight?: number;
  initialX?: number;
  initialY?: number;
  minWidth?: number;
  minHeight?: number;
  /** If set, panel snaps below this element on mount (full width, below bottom). */
  anchorBelowSelector?: string;
  /** If set, panel matches rect of this element on mount (position + size). */
  matchRectSelector?: string;
}

export function LA3DFloatingPanel({
  title, onClose, children,
  initialWidth = 420, initialHeight = 380,
  initialX, initialY,
  minWidth = 240, minHeight = 240,
  anchorBelowSelector,
  matchRectSelector,
}: Props) {
  const computeInitial = () => {
    if (matchRectSelector) {
      const el = document.querySelector(matchRectSelector) as HTMLElement | null;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return {
            x: r.left,
            y: r.top,
            w: Math.max(minWidth, r.width),
            h: Math.max(minHeight, r.height),
          };
        }
      }
    }
    if (anchorBelowSelector) {
      const el = document.querySelector(anchorBelowSelector) as HTMLElement | null;
      if (el) {
        const r = el.getBoundingClientRect();
        const w = Math.min(initialWidth, Math.max(minWidth, r.width));
        const h = Math.min(initialHeight, Math.max(minHeight, window.innerHeight - r.bottom - 20));
        return { x: r.left, y: r.bottom + 6, w, h };
      }
    }
    return {
      x: initialX ?? Math.max(0, window.innerWidth - initialWidth - 20),
      y: initialY ?? Math.max(0, window.innerHeight - initialHeight - 40),
      w: initialWidth, h: initialHeight,
    };
  };
  const init = computeInitial();
  const [pos, setPos] = useState({ x: init.x, y: init.y });
  const [size, setSize] = useState({ w: init.w, h: init.h });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const d = dragRef.current;
        setPos({
          x: Math.max(0, Math.min(window.innerWidth - 120, d.origX + e.clientX - d.startX)),
          y: Math.max(0, Math.min(window.innerHeight - 40, d.origY + e.clientY - d.startY)),
        });
      }
      if (resizeRef.current) {
        const r = resizeRef.current;
        setSize({
          w: Math.max(minWidth, r.origW + e.clientX - r.startX),
          h: Math.max(minHeight, r.origH + e.clientY - r.startY),
        });
      }
    };
    const onUp = () => { dragRef.current = null; resizeRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [minWidth, minHeight]);

  const onHeaderDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
  };
  const onResizeDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
  };

  return createPortal(
    <div style={{
      position: 'fixed', left: pos.x, top: pos.y,
      width: size.w, height: size.h,
      background: '#0e1620',
      border: '1px solid #3e4a5a',
      borderRadius: 8,
      zIndex: 10000,
      boxShadow: '0 4px 28px rgba(0,0,0,0.65)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div
        onMouseDown={onHeaderDown}
        style={{
          padding: '8px 12px',
          background: 'linear-gradient(180deg, #1d2636, #141c28)',
          cursor: 'move',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderBottom: '1px solid #2a3444',
          fontSize: 12, color: '#e2e8f0', fontWeight: 600,
          userSelect: 'none',
        }}
      >
        <span>{title}</span>
        <button
          onClick={onClose}
          style={{
            background: 'transparent', color: '#ff8a8a', border: '1px solid #3e4a5a',
            cursor: 'pointer', fontSize: 14, padding: 0, width: 22, height: 22,
            borderRadius: 4, lineHeight: 1,
          }}
          title="Close"
        >×</button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
        {children}
      </div>
      <div
        onMouseDown={onResizeDown}
        style={{
          position: 'absolute', right: 0, bottom: 0,
          width: 16, height: 16, cursor: 'nwse-resize',
          background: 'linear-gradient(135deg, transparent 45%, #5a6a7e 45%, #5a6a7e 55%, transparent 55%, transparent 70%, #5a6a7e 70%, #5a6a7e 80%, transparent 80%)',
        }}
        title="Drag to resize"
      />
    </div>,
    document.body
  );
}
