import { MARK } from '@shared/brand';

/** Quorum-Marke: drei scharfe Scherben (drei Modelle) um eine kleine Mitte (der Konsens). Geometrie aus shared/brand.ts. */
export function Logo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} role="img" aria-label="Quorum" shapeRendering="geometricPrecision">
      {MARK.map((s, i) => (
        <polygon key={i} points={s.pts.map((p) => p.join(',')).join(' ')} fill={i === MARK.length - 1 ? 'var(--c-text)' : `rgb(${s.color.join(',')})`} />
      ))}
    </svg>
  );
}
