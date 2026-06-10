export default function get(source: unknown, path: string | Array<string | number>, defaultValue?: unknown) {
  const segments = Array.isArray(path)
    ? path
    : path
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .filter(Boolean);

  let value = source as Record<string | number, unknown> | null | undefined;
  for (const segment of segments) {
    if (value == null) return defaultValue;
    value = value[segment] as Record<string | number, unknown> | null | undefined;
  }

  return value === undefined ? defaultValue : value;
}
