import React from 'react';
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives';

/** Reuse the host's indicator, animation, theme and reduced-motion behavior. */
export function ActivityIndicator({ activity }) {
  if (!activity) return null;
  return (
    <span className="dsr-activity" role="img" aria-label={activity.label} title={activity.label}>
      <StateDot state={activity.state} />
    </span>
  );
}
