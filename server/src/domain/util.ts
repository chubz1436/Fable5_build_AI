let counter = 0;

/** Short unique id with a readable prefix, e.g. `task_m3k9x2_07a1`. */
export function uid(prefix: string): string {
  counter = (counter + 1) % 46656; // 36^3
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  const seq = counter.toString(36).padStart(3, '0');
  return `${prefix}_${time}${rand}${seq}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic PRNG (mulberry32) seeded from a string — used by the simulator. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
