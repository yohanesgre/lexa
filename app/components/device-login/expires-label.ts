export function expiresInLabel(expiresAt: string, now: number): string {
  const min = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - now) / 60_000));
  return `expires in ${min} min`;
}