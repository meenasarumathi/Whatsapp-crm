import { useId } from "react";
import { cn } from "@/lib/utils";

// Zyloop brand mark: a rounded tile in the brand gradient carrying a
// "Z" drawn as one continuous loop — a conversation that comes back
// around. Pure SVG so it scales from favicon to login hero.

export function BrandMark({ className, title = "Zyloop" }: { className?: string; title?: string }) {
  // Unique per instance: a shared id breaks when the first copy sits in a
  // display:none container (e.g. the auth side panel on phones).
  const gradientId = `zyloop-g-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 40 40" role="img" aria-label={title} className={cn("h-8 w-8 shrink-0", className)}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="0.55" stopColor="#14b8a6" />
          <stop offset="1" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill={`url(#${gradientId})`} />
      <path
        d="M12 13.5h14.5L13 26.5h12.5a3.5 3.5 0 1 0-3.5-3.5"
        fill="none"
        stroke="#fff"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="29" cy="12" r="2.2" fill="#fff" fillOpacity="0.85" />
    </svg>
  );
}

/** Mark + wordmark, used in the sidebar and the auth pages. */
export function BrandLockup({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark className={compact ? "h-7 w-7" : "h-9 w-9"} />
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-extrabold tracking-tight text-foreground">Zyloop</span>
        <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">WACRM</span>
      </span>
    </span>
  );
}
