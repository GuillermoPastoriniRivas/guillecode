export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`logo${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Flufy"
    >
      <rect width="32" height="32" rx="7" fill="#05070d" />
      <g stroke="#8b84ff" strokeWidth="1.7" strokeLinecap="round">
        <line x1="8.67" y1="8.64" x2="23.97" y2="7.1" />
        <line x1="8.67" y1="8.64" x2="24.67" y2="23.68" />
        <line x1="8.67" y1="8.64" x2="9.6" y2="26.2" />
      </g>
      <g fill="#8b84ff">
        <circle cx="8.67" cy="8.64" r="5.3" />
        <circle cx="23.97" cy="7.1" r="2.56" />
        <circle cx="24.67" cy="23.68" r="2.47" />
        <circle cx="9.6" cy="26.2" r="2.47" />
      </g>
    </svg>
  )
}
