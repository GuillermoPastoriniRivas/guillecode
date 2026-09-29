import { useId } from "react"

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "")
  return (
    <svg
      className={`logo${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="GuilleCode"
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#34d399" />
          <stop offset="0.58" stopColor="#10b981" />
          <stop offset="1" stopColor="#047857" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="0.5" stopColor="#f5c542" />
          <stop offset="1" stopColor="#b8860b" />
        </linearGradient>
      </defs>
      <rect x="48" y="48" width="928" height="928" rx="216" fill={`url(#${id}-bg)`} />
      <rect x="48" y="48" width="928" height="928" rx="216" fill={`url(#${id}-shine)`} />
      <path
        d="M 644 398 A 232 232 0 1 0 712 562 L 530 562"
        fill="none"
        stroke="#ffffff"
        strokeWidth="112"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="logo-spark"
        d="M 800 172 C 810 236 832 258 896 268 C 832 278 810 300 800 364 C 790 300 768 278 704 268 C 768 258 790 236 800 172 Z"
        fill={`url(#${id}-gold)`}
      />
    </svg>
  )
}
