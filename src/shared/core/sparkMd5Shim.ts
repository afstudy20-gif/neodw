function hash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x85ebca6b;
  let h4 = 0xc2b2ae35;

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 + code, 0x27d4eb2d);
    h3 = Math.imul(h3 ^ (code + i), 0x165667b1);
    h4 = Math.imul(h4 + (code ^ i), 0x9e3779b1);
  }

  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
  return `${hex(h1)}${hex(h2)}${hex(h3)}${hex(h4)}`;
}

export default {
  hash,
};
