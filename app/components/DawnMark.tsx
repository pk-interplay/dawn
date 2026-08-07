/**
 * Dawn's logo mark: a crescent rising over a horizon line, transcribed from
 * /Dawn/dawn-mark.svg on the reference build.
 *
 * The crescent is a mask rather than a path — a filled circle with an ellipse
 * punched out of it, then clipped to the top 46px of the box so the shape reads
 * as a sun/moon cresting the line rather than a full ring.
 *
 * Colour comes from `currentColor` (the reference hard-codes #e8e6e1), so the
 * mark tracks whatever text colour its lockup sits in. Size it by setting a
 * height in `className`; the viewBox handles the rest.
 */

/** The mask needs a document-unique id. Pass `idSuffix` when two marks share a page. */
export function DawnMark({
  className,
  idSuffix = "default",
}: {
  className?: string;
  idSuffix?: string;
}) {
  const maskId = `dawn-crescent-${idSuffix}`;

  return (
    <svg
      viewBox="0 0 90 62"
      className={className}
      role="img"
      aria-label="Dawn logo mark"
      style={{ width: "auto" }}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect x="0" y="0" width="90" height="62" fill="black" />
          <circle cx="44" cy="46" r="26" fill="white" />
          <ellipse cx="44" cy="46" rx="26" ry="17" fill="black" />
        </mask>
      </defs>
      <rect x="0" y="0" width="90" height="46" fill="currentColor" mask={`url(#${maskId})`} />
      <line
        x1="8"
        y1="43"
        x2="80"
        y2="43"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
