type SeedRandomOptions = {
  global?: boolean;
};

type SeededRandom = (() => number) & {
  quick: () => number;
};

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): SeededRandom {
  let state = seed || 0x6d2b79f5;
  const random = (() => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as SeededRandom;

  random.quick = random;
  return random;
}

export default function seedrandom(seed: string | number = Date.now(), options: SeedRandomOptions = {}) {
  const random = mulberry32(hashSeed(String(seed)));
  if (options.global) {
    Math.random = random;
  }
  return random;
}
