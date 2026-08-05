const bodyMb = Number(process.env.LXK_MAX_BODY_MB ?? 16);
export const MAX_API_BODY = (Number.isFinite(bodyMb) && bodyMb > 0 ? bodyMb : 16) * 1024 * 1024;
export const X_LEXA_REMOTE_IP = "x-lexa-remote-ip";
