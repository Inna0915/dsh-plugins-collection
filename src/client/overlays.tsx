import React, { useEffect, useRef, useState } from 'react';

const overlays: Array<{ id: symbol; ref: React.RefObject<HTMLElement | null> }> = [];
export function useOverlay(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const id = Symbol('overlay');
    const entry = { id, ref };
    overlays.push(entry);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      const focusedBoard = (document.activeElement as HTMLElement | null)?.closest('.jf-app');
      const visible = overlays.filter(({ ref }) => {
        const node = ref.current;
        return (
          node &&
          !node.closest('[inert]') &&
          node.getClientRects().length &&
          (!focusedBoard || node.closest('.jf-app') === focusedBoard)
        );
      });
      if (visible.at(-1) !== entry) return;
      // A workspace modal belongs to its board; keyboard input in the chat or
      // another docked tool must keep working while the modal is open.
      if (ref.current?.closest('.jf-app-pane') && focusedBoard !== ref.current.closest('.jf-app')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      }
      if (event.key === 'Tab') {
        const nodes = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
          ) || []),
        ].filter((node) => node.getClientRects().length);
        const first = nodes[0],
          last = nodes.at(-1);
        if (!first) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === ref.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      const wasTop = overlays.at(-1) === entry;
      overlays.splice(overlays.indexOf(entry), 1);
      document.removeEventListener('keydown', key, true);
      if (wasTop && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [ref]);
}

export interface PreviewImage {
  url: string;
  alt: string;
}
export function ImageViewer({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useOverlay(ref, onClose);
  const zoom = (step: number) => setScale((value) => Math.max(0.25, Math.min(4, (value ?? 1) + step)));
  return (
    <div
      className="jf-lightbox-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        className="jf-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="图片大图预览"
      >
        <header>
          <span title={image.alt}>{image.alt || '任务图片'}</span>
          <div>
            <button onClick={() => zoom(-0.25)} aria-label="缩小图片">
              −
            </button>
            <output>{scale === null ? '适应窗口' : `${Math.round(scale * 100)}%`}</output>
            <button onClick={() => zoom(0.25)} aria-label="放大图片">
              ＋
            </button>
            <button onClick={() => setScale(null)}>适应窗口</button>
            <button onClick={() => setScale(1)}>100%</button>
            <button aria-label="关闭图片预览" onClick={onClose}>
              ×
            </button>
          </div>
        </header>
        <div
          className={`jf-image-stage ${scale === null ? 'is-fit' : 'is-zoomed'}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <img
            src={image.url}
            alt={image.alt}
            draggable={false}
            style={
              scale !== null && size.width
                ? { width: size.width * scale, height: size.height * scale }
                : undefined
            }
            onLoad={(event) =>
              setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            }
            onDoubleClick={() => setScale((value) => (value === null ? 1 : null))}
          />
        </div>
        <footer>双击切换原始尺寸 · 放大后滚动查看 · Esc 关闭</footer>
      </section>
    </div>
  );
}
