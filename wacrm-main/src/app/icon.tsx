import { ImageResponse } from "next/og";

// Zyloop brand mark as the favicon — same gradient tile and looped "Z"
// as `BrandMark` in src/components/brand/brand-mark.tsx. Next.js renders
// this at build time and auto-injects <link rel="icon"> into <head>.

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #22d3ee 0%, #14b8a6 55%, #6366f1 100%)",
          borderRadius: 9,
        }}
      >
        <svg width="24" height="24" viewBox="0 0 40 40" fill="none">
          <path
            d="M12 13.5h14.5L13 26.5h12.5a3.5 3.5 0 1 0-3.5-3.5"
            stroke="#ffffff"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
