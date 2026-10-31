import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import type { Issue, Profile, Transition, TransitionContext } from '../types.js';
import { api } from './api.js';
import { requiresTransitionInput } from '../shared/workflow.js';
import {
  constrain,
  keepTargetsStill,
  placeTargets,
  type DragPoint,
  type TargetPlacement,
} from '../shared/drag-position.js';

interface DragState {
  issue: Issue;
  targets?: Transition[];
  error?: string;
  keyboard: boolean;
}
export function useTaskDrag(
  profile: Profile | undefined,
  onChoose: (issue: Issue, target: Transition) => void,
) {
  const [drag, setDrag] = useState<DragState>();
  const [hovered, setHovered] = useState('');
  const state = useRef<DragState | undefined>(undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  const layerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const pointRef = useRef<DragPoint>({ x: 0, y: 0 });
  const imageRef = useRef<HTMLCanvasElement | undefined>(undefined);
  const focusRef = useRef<HTMLElement | undefined>(undefined);
  const clear = () => {
    pending.current?.abort();
    pending.current = undefined;
    state.current = undefined;
    imageRef.current?.remove();
    imageRef.current = undefined;
    focusRef.current?.focus({ preventScroll: true });
    focusRef.current = undefined;
    setDrag(undefined);
    setHovered('');
  };
  useEffect(() => {
    clear();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && state.current) {
        event.preventDefault();
        event.stopPropagation();
        clear();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      pending.current?.abort();
      state.current = undefined;
      imageRef.current?.remove();
      document.removeEventListener('keydown', key, true);
    };
  }, [profile?.id]);
  useLayoutEffect(() => {
    if (!drag) return;
    const layer = layerRef.current!,
      target = targetRef.current!;
    let frame = 0;
    let placement: TargetPlacement | undefined;
    let previous: DragPoint | undefined;
    let locked = false;
    let resized = false;
    const position = () => {
      frame = 0;
      const bounds = layer.getBoundingClientRect();
      layer.style.setProperty('--jf-drag-height', `${Math.max(0, bounds.height - 24)}px`);
      const point = { x: pointRef.current.x - bounds.left, y: pointRef.current.y - bounds.top };
      const size = { width: target.offsetWidth, height: target.offsetHeight };
      if (placement && previous && !drag.keyboard) {
        locked = keepTargetsStill(point, previous, placement, locked);
      }
      if (!placement || !locked || resized) {
        placement = placeTargets(locked && placement ? placement.anchor : point, size, bounds);
        target.style.transform = `translate3d(${placement.x}px, ${placement.y}px, 0)`;
        target.dataset.side = placement.side;
      }
      previous = point;
      resized = false;
      const preview = previewRef.current;
      if (preview) {
        const x = placement.side === 'right' ? point.x - preview.offsetWidth - 16 : point.x + 16;
        preview.style.transform = `translate3d(${constrain(x, bounds.width - preview.offsetWidth)}px, ${constrain(point.y - 32, bounds.height - preview.offsetHeight)}px, 0)`;
        preview.style.visibility = bounds.width < 560 ? 'hidden' : 'visible';
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(position);
    };
    const move = (event: DragEvent) => {
      if (!state.current || drag.keyboard) return;
      pointRef.current = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const observer = new ResizeObserver(() => {
      resized = true;
      schedule();
    });
    observer.observe(layer);
    observer.observe(target);
    document.addEventListener('dragover', move, true);
    position();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('dragover', move, true);
    };
  }, [drag?.issue.key, drag?.keyboard]);
  useEffect(() => {
    if (drag?.keyboard && drag.targets)
      targetRef.current?.querySelector<HTMLButtonElement>('.jf-drop-target')?.focus({ preventScroll: true });
  }, [drag?.keyboard, drag?.targets]);
  function begin(issue: Issue, event?: React.DragEvent, anchor?: HTMLElement) {
    if (!profile?.allowWrites) {
      event?.preventDefault();
      return;
    }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const value: DragState = { issue, keyboard: !event };
    state.current = value;
    const bounds = anchor?.getBoundingClientRect();
    pointRef.current = event
      ? { x: event.clientX, y: event.clientY }
      : { x: bounds?.right ?? window.innerWidth / 2, y: bounds?.top ?? window.innerHeight / 2 };
    focusRef.current = anchor;
    if (event) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/jira-key', issue.key);
      // Use our compact preview instead of the browser's full-card drag image.
      imageRef.current?.remove();
      const image = document.createElement('canvas');
      image.width = image.height = 1;
      Object.assign(image.style, { position: 'fixed', left: '0', top: '0', pointerEvents: 'none' });
      document.body.appendChild(image);
      imageRef.current = image;
      event.dataTransfer.setDragImage(image, 0, 0);
    }
    setDrag(value);
    setHovered('');
    void api<TransitionContext>(
      'transition-context',
      { profile: profile.id, key: issue.key },
      controller.signal,
    )
      .then(({ issue: current, transitions: targets }) => {
        if (controller.signal.aborted || state.current !== value) return;
        const ready = { ...value, issue: current, targets };
        state.current = ready;
        setDrag(ready);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        const failed = { ...value, error: error instanceof Error ? error.message : '读取流转失败' };
        state.current = failed;
        setDrag(failed);
      });
  }
  function choose(target: Transition, event?: React.DragEvent) {
    event?.preventDefault();
    event?.stopPropagation();
    const current = state.current;
    if (!current?.targets?.some((row) => row.id === target.id)) return;
    if (event && event.dataTransfer.getData('text/jira-key') !== current.issue.key) return;
    clear();
    onChoose(current.issue, target);
  }
  const panel = drag && (
    <div ref={layerRef} className="jf-drag-layer">
      {!drag.keyboard && (
        <div ref={previewRef} className="jf-drag-preview-position" aria-hidden="true">
          <div
            className={`jf-drag-preview ${drag.issue.type.toLowerCase().includes('bug') ? 'is-bug' : 'is-story'}`}
          >
            <div>
              <span>{drag.issue.type}</span>
              <strong>{drag.issue.key}</strong>
            </div>
            <p>{drag.issue.summary}</p>
            <small>{drag.issue.status.name}</small>
          </div>
        </div>
      )}
      <div ref={targetRef} className="jf-drag-position">
        <section className="jf-drag-targets" aria-label="可流转目标">
          <header>
            <div>
              <strong>{drag.issue.key}</strong>
              <span>从「{drag.issue.status.name}」移至</span>
            </div>
            <button aria-label="取消拖动" onClick={clear}>
              ×
            </button>
          </header>
          {!drag.targets && !drag.error && (
            <p className="jf-drag-loading">
              <span className="jf-spinner" /> 正在读取可到达的节点…
            </p>
          )}
          {drag.error && <p className="jf-error">{drag.error}，请松开后重试。</p>}
          {drag.targets?.length === 0 && <p className="jf-muted">当前没有可用的流转节点。</p>}
          <div className="jf-drag-target-grid">
            {drag.targets?.map((target) => (
              <button
                key={target.id}
                className={`jf-drop-target ${hovered === target.id ? 'is-over' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setHovered(target.id);
                }}
                onDragLeave={(event) => {
                  if (
                    !(event.relatedTarget instanceof Node) ||
                    !event.currentTarget.contains(event.relatedTarget)
                  )
                    setHovered('');
                }}
                onDrop={(event) => choose(target, event)}
                onClick={() => choose(target)}
              >
                <span className="jf-target-arrow" aria-hidden="true">
                  →
                </span>
                <span className="jf-target-label">
                  <strong>{target.to.name}</strong>
                  <span>{target.name}</span>
                  {requiresTransitionInput(target) && <small>需补充必填信息</small>}
                </span>
                <span className="jf-target-release">{drag.keyboard ? '选择' : '松手'}</span>
              </button>
            ))}
          </div>
          <footer>{drag.keyboard ? '选择目标状态' : '移到节点后松手'} · Esc 取消</footer>
        </section>
      </div>
    </div>
  );
  return { drag, begin, clear, panel };
}

export function useCardMotion(ref: React.RefObject<HTMLElement | null>, dependency: unknown) {
  const positions = useRef(new Map<string, DOMRect>());
  const animations = useRef(new Set<Animation>());
  useEffect(
    () => () => {
      for (const animation of animations.current) animation.cancel();
    },
    [],
  );
  const read = () =>
    new Map(
      [...(ref.current?.querySelectorAll<HTMLElement>('[data-task-key]') || [])].map((node) => [
        node.dataset.taskKey!,
        node.getBoundingClientRect(),
      ]),
    );
  const capture = () => {
    positions.current = read();
  };
  useLayoutEffect(() => {
    const next = read();
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const node of ref.current?.querySelectorAll<HTMLElement>('[data-task-key]') || []) {
        const before = positions.current.get(node.dataset.taskKey!),
          after = next.get(node.dataset.taskKey!);
        if (!before || !after) continue;
        const x = before.left - after.left,
          y = before.top - after.top;
        if (Math.abs(x) + Math.abs(y) < 2) continue;
        // A floating copy keeps a cross-column move visible outside the columns'
        // independent scrolling clips. The actual card stays in its new layout.
        let animatedNode = node;
        let cleanup = () => {};
        if (Math.abs(x) > 2) {
          const host = node.closest<HTMLElement>('.jf-app')!;
          const origin = host.getBoundingClientRect();
          const ghost = node.cloneNode(true) as HTMLElement;
          ghost.removeAttribute('data-task-key');
          ghost.setAttribute('aria-hidden', 'true');
          ghost.inert = true;
          Object.assign(ghost.style, {
            position: 'absolute',
            left: `${after.left - origin.left}px`,
            top: `${after.top - origin.top}px`,
            width: `${after.width}px`,
            height: `${after.height}px`,
            margin: '0',
            pointerEvents: 'none',
            zIndex: '80',
          });
          host.appendChild(ghost);
          node.style.opacity = '0';
          animatedNode = ghost;
          cleanup = () => {
            ghost.remove();
            node.style.opacity = '';
          };
        }
        const animation = animatedNode.animate(
          [
            { transform: `translate(${x}px, ${y}px)`, opacity: 0.65 },
            { transform: 'translate(0,0)', opacity: 1 },
          ],
          { duration: 320, easing: 'cubic-bezier(.2,.75,.25,1)' },
        );
        animations.current.add(animation);
        const finish = () => {
          cleanup();
          animations.current.delete(animation);
        };
        animation.onfinish = finish;
        animation.oncancel = finish;
      }
    }
    positions.current = next;
  }, [dependency]);
  return capture;
}
