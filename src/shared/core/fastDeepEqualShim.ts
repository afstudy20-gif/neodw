export default function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (a !== a && b !== b) return true;

  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }

  if ((a as object).constructor !== (b as object).constructor) {
    return false;
  }

  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    for (let i = a.length - 1; i >= 0; i--) {
      if (!deepEqual(a[i], other[i])) return false;
    }
    return true;
  }

  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  if (a.valueOf !== Object.prototype.valueOf) {
    return a.valueOf() === (b as { valueOf: () => unknown }).valueOf();
  }

  if (a.toString !== Object.prototype.toString) {
    return a.toString() === (b as { toString: () => string }).toString();
  }

  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;

  for (let i = keys.length - 1; i >= 0; i--) {
    if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
  }

  for (let i = keys.length - 1; i >= 0; i--) {
    const key = keys[i] as keyof typeof a;
    if (!deepEqual(a[key], (b as typeof a)[key])) return false;
  }

  return true;
}
