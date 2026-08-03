export function parseApiDate(value: string): Date {
  if (value.includes("T") || value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value)) {
    return new Date(value);
  }
  return new Date(`${value.replace(" ", "T")}Z`);
}
