// Times are stored in UTC and shown to people in India time (Asia/Kolkata).

const FORMAT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** e.g. "1 Nov 2026, 12:30 am IST". Empty string for missing or invalid input. */
export function formatIst(value: string | Date | null | undefined): string {
  if (value == null) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${FORMAT.format(d).replace(/\s?(AM|PM)$/i, (m) => m.toLowerCase())} IST`;
}
