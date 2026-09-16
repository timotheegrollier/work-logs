import { useRef, useState, type PointerEvent } from 'react';

/** La capture garde le glissement actif même quand le pointeur quitte la poignée. */
export function ColumnResizer({ side, panelId, value, onChange }: {
  side: 'left' | 'right'; panelId: string; value: number; onChange: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const direction = side === 'left' ? 1 : -1;
  const label = `Redimensionner la colonne de ${side === 'left' ? 'gauche' : 'droite'}`;
  const resize = (width: number) => onChange(Math.max(120, Math.min(600, Math.round(width))));
  // La grille peut réduire une largeur mémorisée lorsque la fenêtre rétrécit.
  const currentWidth = () => document.getElementById(panelId)?.getBoundingClientRect().width ?? value;

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start?.pointerId === event.pointerId) resize(start.width + direction * (event.clientX - start.x));
  };
  const stop = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div
    className={`column-resizer column-resizer-${side} no-print${dragging ? ' is-dragging' : ''}`}
    role="separator"
    aria-label={label}
    aria-controls={panelId}
    aria-orientation="vertical"
    aria-valuemin={120}
    aria-valuemax={600}
    aria-valuenow={value}
    aria-valuetext={`${value} pixels`}
    tabIndex={0}
    title={`${label} · glisser ou utiliser les flèches gauche/droite`}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, width: currentWidth() };
      setDragging(true);
    }}
    onPointerMove={move}
    onPointerUp={event => { move(event); stop(event); }}
    onPointerCancel={stop}
    onLostPointerCapture={stop}
    onKeyDown={event => {
      const step = event.shiftKey ? 50 : 10;
      let width: number;
      if (event.key === 'ArrowLeft') width = currentWidth() - direction * step;
      else if (event.key === 'ArrowRight') width = currentWidth() + direction * step;
      else if (event.key === 'Home') width = 120;
      else if (event.key === 'End') width = 600;
      else return;
      event.preventDefault();
      resize(width);
    }}
  />;
}
