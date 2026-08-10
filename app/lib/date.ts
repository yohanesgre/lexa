export function parseApiDate(value: string): Date {
  // Explicit offsets (Z or ±hh:mm) are TZ-aware — pass through as-is. Every
  // other form is assumed to be a UTC instant: SQLite datetimes (space-form)
  // and any T-separated no-offset value get a Z suffix so the browser never
  // re-interprets them as local time.
  if (value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value)) {
    return new Date(value);
  }
  return new Date(`${value.replace(" ", "T")}Z`);
}
