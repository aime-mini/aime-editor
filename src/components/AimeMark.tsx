import { useId } from "react";

/**
 * Aime's logo, drawing itself: the tile arrives, the prompt is stroked in, the
 * cursor blinks and the spark flares - then flares again every few seconds,
 * so the screen it sits on is alive without anything asking for attention.
 *
 * Geometry from `src/assets/logo.svg`; the motion lives in `index.css`
 * (`.aime-mark`) and matches the starting window's (`splash.html`), which
 * cannot import either - keep the three in step.
 */
export function AimeMark({ className }: { className?: string }) {
  // Two marks on one page must not share a gradient id.
  const fill = useId();
  return (
    <svg viewBox="0 0 1024 1024" className={`aime-mark ${className ?? ""}`} aria-hidden>
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5B7CFF" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect className="tile" x="64" y="64" width="896" height="896" rx="200" fill={`url(#${fill})`} />
      <path
        className="prompt"
        d="M 300 360 L 462 512 L 300 664"
        pathLength={1}
        fill="none"
        stroke="#fff"
        strokeWidth="76"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect className="cursor" x="516" y="612" width="196" height="76" rx="38" fill="#fff" />
      <path
        className="spark"
        d="M 706 236 L 733 313 L 810 340 L 733 367 L 706 444 L 679 367 L 602 340 L 679 313 Z"
        fill="#fff"
      />
    </svg>
  );
}
