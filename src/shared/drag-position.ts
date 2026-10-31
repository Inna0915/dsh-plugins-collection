export interface DragPoint {
  x: number;
  y: number;
}
export interface DragBounds {
  width: number;
  height: number;
}
export interface TargetPlacement extends DragPoint {
  width: number;
  height: number;
  side: 'left' | 'right';
  anchor: DragPoint;
}

const inset = 12;
export const constrain = (value: number, maximum: number) =>
  Math.max(inset, Math.min(value, Math.max(inset, maximum - inset)));

export function placeTargets(point: DragPoint, size: DragBounds, bounds: DragBounds): TargetPlacement {
  const width = Math.min(size.width, Math.max(0, bounds.width - inset * 2));
  const height = Math.min(size.height, Math.max(0, bounds.height - inset * 2));
  const side = point.x + 28 + width <= bounds.width - inset || point.x < bounds.width / 2 ? 'right' : 'left';
  return {
    x: constrain(side === 'right' ? point.x + 28 : point.x - width - 28, bounds.width - width),
    y: constrain(point.y - 48, bounds.height - height),
    width,
    height,
    side,
    anchor: { ...point },
  };
}

// Keep a reachable corridor between the card and its targets. A panel that
// follows every horizontal mouse movement would forever evade a slow drag.
export function keepTargetsStill(
  point: DragPoint,
  previous: DragPoint,
  panel: TargetPlacement,
  locked: boolean,
) {
  const inPanel =
    point.x >= panel.x - 8 &&
    point.x <= panel.x + panel.width + 8 &&
    point.y >= panel.y - 8 &&
    point.y <= panel.y + panel.height + 8;
  const inCorridor =
    point.x >= Math.min(panel.anchor.x - 24, panel.x - 8) &&
    point.x <= Math.max(panel.anchor.x + 24, panel.x + panel.width + 8) &&
    point.y >= Math.min(panel.anchor.y - 24, panel.y - 8) &&
    point.y <= Math.max(panel.anchor.y + 24, panel.y + panel.height + 8);
  const toward = panel.side === 'right' ? point.x > previous.x : point.x < previous.x;
  return inPanel || (inCorridor && (locked || toward));
}
