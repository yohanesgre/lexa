export function expiresInLabel(expiresAt: string, now: number): string {
  const remaining = new Date(expiresAt).getTime() - now;
  if (remaining <= 0) return "expired";
  const min = Math.max(1, Math.ceil(remaining / 60_000));
  return `expires in ${min} min`;
}