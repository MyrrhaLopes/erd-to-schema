import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/** Comparação de índices fracionários: ordem de bytes, nunca `localeCompare` */
export const cmpKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Ordena por (order, id): empates (inserções concorrentes no mesmo lugar) desempatam pelo ID */
export function byOrder<T extends { id: string }>(items: T[], orderOf: (t: T) => string | undefined): T[] {
  return [...items].sort((a, b) => cmpKey(orderOf(a) ?? '', orderOf(b) ?? '') || cmpKey(a.id, b.id));
}

const isKey = (k: unknown): k is string => {
  if (typeof k !== 'string' || !k) return false;
  try {
    generateKeyBetween(k, null);
    return true;
  } catch {
    return false;
  }
};

/**
 * Dada a ordem desejada e a chave atual de cada item, devolve só as chaves que precisam
 * mudar. Mantém a maior subsequência já ordenada (LIS) e gera chaves novas entre os
 * vizinhos mantidos para o resto: mover uma coluna reescreve uma chave, não todas.
 */
export function reorder(ids: string[], current: (id: string) => unknown): Map<string, string> {
  const keys = ids.map((id) => {
    const k = current(id);
    return isKey(k) ? k : undefined;
  });
  // LIS estrita sobre as chaves existentes (O(n log n))
  const tails: number[] = [];
  const prev = new Array<number>(ids.length).fill(-1);
  for (let i = 0; i < ids.length; i++) {
    const k = keys[i];
    if (k === undefined) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[tails[mid]]! < k) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);

  const out = new Map<string, string>();
  let i = 0;
  while (i < ids.length) {
    if (keep.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < ids.length && !keep.has(j)) j++;
    const lower = i > 0 ? keys[i - 1]! : null;
    const upper = j < ids.length ? keys[j]! : null;
    const fresh = generateNKeysBetween(lower, upper, j - i);
    for (let k = i; k < j; k++) {
      out.set(ids[k], fresh[k - i]);
      keys[k] = fresh[k - i];
    }
    i = j;
  }
  return out;
}
