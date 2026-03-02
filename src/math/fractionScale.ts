import { divBigintToNumber } from "../utils/bn.js";

export const SF_BITS = 60n;
export const SF_SCALE = 1n << SF_BITS; // 2^60

export function sfToNumber(sfRaw: bigint, precision = 6): number {
  return divBigintToNumber(sfRaw, SF_SCALE, precision);
}
