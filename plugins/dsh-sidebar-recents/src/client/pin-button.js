import React, { useRef, useState } from 'react';

export function PinButton({ pinned, name, onToggle, onError }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const label = `${pinned ? '取消置顶' : '置顶'}${name}`;
  return (
    <button
      type="button"
      className="dsr-pin-button"
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      disabled={busy}
      onClick={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        onError('');
        try {
          await onToggle();
        } catch {
          onError(`${label}失败，请重试`);
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      }}
    >
      <svg viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z" />
        <path d="M12 15v6" />
      </svg>
    </button>
  );
}
