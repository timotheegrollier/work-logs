import { Children, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

/**
 * Les actions IA d'une note, d'un fichier ou d'une tâche derrière un seul « ✨ IA » :
 * une pastille par action encombrait la rangée. Même clavier que le menu du compte.
 * Le menu se referme dès qu'on choisit : le bouton affiche alors l'attente (`busy`),
 * et « Arrêter » (`onCancel`) coupe la demande sans attendre la fin de la chaîne de secours.
 */
export function AiMenu({ label, busy, onCancel, className = 'ghost', children }: {
  label: string;
  busy?: string | null;
  onCancel?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  // Secondes d'attente, affichées passé trois : un modèle saturé peut mettre 45 s.
  const [seconds, setSeconds] = useState(0);
  const waiting = Boolean(busy);
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  // Au bout d'une rangée qui défile (téléphone), « Arrêter » naîtrait hors de l'écran, et le
  // compteur l'en repousse : seule la rangée défile, jamais la page.
  useEffect(() => {
    const stop = stopRef.current;
    const row = rootRef.current?.parentElement;
    if (!stop || !row) return;
    const hidden = stop.getBoundingClientRect().right - row.getBoundingClientRect().right;
    if (hidden > 0) row.scrollLeft += hidden;
  }, [busy, seconds >= 3 && String(seconds).length]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    // Tout le menu à l'écran (au pied d'une carte, sur mobile au-dessus de la barre du bas), puis le clavier dedans.
    menuRef.current?.scrollIntoView?.({ block: 'nearest' });
    (menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? menuRef.current)?.focus({ preventScroll: true });
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  if (Children.toArray(children).length === 0) return null;

  const closeToTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const onMenuClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[role="menuitem"]')) closeToTrigger();
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeToTrigger();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="ai-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        className={className + (busy ? ' is-busy' : '')}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={busy || label}
        title={busy && seconds >= 15 ? 'Le modèle met du temps : « Arrêter » coupe la demande.' : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {busy
          ? <><span className="ai-spark" aria-hidden="true">✨</span>{busy}{seconds >= 3 && <span className="ai-elapsed" aria-hidden="true"> {seconds} s</span>}</>
          : <><span aria-hidden="true">✨ </span>IA<span className="ai-menu-caret" aria-hidden="true">▾</span></>}
      </button>
      {busy && onCancel && (
        <button ref={stopRef} className={className} type="button" aria-label="Arrêter la demande IA" onClick={() => { onCancel(); triggerRef.current?.focus(); }}>
          Arrêter
        </button>
      )}
      {open && (
        <div className="ai-menu-popover" id={menuId} role="menu" aria-label={label} tabIndex={-1} ref={menuRef} onClick={onMenuClick} onKeyDown={onMenuKey}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Ce que l'IA prépare, à la place de la proposition qui va venir : on voit que ça travaille, et où. */
export function AiPending({ label }: { label: string }) {
  return (
    <div className="ai-pending no-print" role="status">
      <span><span className="ai-spark" aria-hidden="true">✨</span>{label}</span>
      <span className="ai-pending-lines" aria-hidden="true"><i /><i /><i /></span>
    </div>
  );
}
