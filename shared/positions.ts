import { generateKeyBetween } from "fractional-indexing";

export const keyAfter = (last: string | null): string => generateKeyBetween(last, null);

export const keyBetween = (a: string | null, b: string | null): string => generateKeyBetween(a, b);
