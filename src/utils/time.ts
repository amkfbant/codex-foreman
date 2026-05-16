export function nowIso(): string {
  return new Date().toISOString();
}

export function dateStamp(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function makeId(prefix: string, sequence = 1, date = new Date()): string {
  const stamp = `${dateStamp(date)}-${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}${String(date.getUTCSeconds()).padStart(2, "0")}${String(date.getUTCMilliseconds()).padStart(3, "0")}`;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${String(sequence).padStart(3, "0")}-${random}`;
}
