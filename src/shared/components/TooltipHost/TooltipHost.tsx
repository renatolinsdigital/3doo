import { useEditorStore } from '@store/index';

import './TooltipHost.scss';

const MARGIN = 8;
const ASSUMED_WIDTH = 240;

/** Renders whatever hint is currently reported by `useTooltipTrigger`. */
export function TooltipHost() {
  const hint = useEditorStore((state) => state.hint);
  if (!hint) return null;

  const left = Math.max(MARGIN, Math.min(hint.x, window.innerWidth - ASSUMED_WIDTH - MARGIN));
  const top = Math.min(hint.y + MARGIN, window.innerHeight - 40);

  return (
    <div className="tooltip-host" role="tooltip" style={{ left, top }}>
      {hint.text}
    </div>
  );
}
