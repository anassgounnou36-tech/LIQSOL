type BNLike = { toString(): string };

/**
 * Converts a BigFractionBytes value to bigint.
 * BigFractionBytes is a Kamino type with structure: { value: [u64; 4], padding: [u64; 2] }
 * The value is stored as 4 little-endian u64 limbs representing a 256-bit number.
 * 
 * @param v - Either { value: [u64; 4] } or directly [u64; 4]
 * @returns BigInt representation of the 256-bit value
 */
export function bigFractionBytesToBigInt(v: unknown): bigint {
  // Handle { value: [u64, u64, u64, u64] } object format
  if (v && typeof v === "object" && "value" in v) {
    const valueArray = (v as { value: unknown }).value;
    if (Array.isArray(valueArray) && valueArray.length >= 4) {
      return bigFractionArrayToBigInt(valueArray);
    }
  }
  
  // Handle direct [u64, u64, u64, u64] array format
  if (Array.isArray(v) && v.length >= 4) {
    return bigFractionArrayToBigInt(v);
  }
  
  throw new Error(`Invalid BigFractionBytes format: ${String(v)}`);
}

/**
 * Converts an array of 4 u64 limbs to a single bigint.
 * Uses little-endian ordering: result = limbs[0] + (limbs[1] << 64) + (limbs[2] << 128) + (limbs[3] << 192)
 */
function bigFractionArrayToBigInt(limbs: unknown[]): bigint {
  if (limbs.length < 4) {
    throw new Error(`BigFraction array must have at least 4 limbs, got ${limbs.length}`);
  }
  
  // Convert each limb to bigint
  const limb0 = toBigInt(limbs[0]);
  const limb1 = toBigInt(limbs[1]);
  const limb2 = toBigInt(limbs[2]);
  const limb3 = toBigInt(limbs[3]);
  
  // Combine little-endian: result = limb0 + (limb1 << 64) + (limb2 << 128) + (limb3 << 192)
  const result = limb0
    + (limb1 << 64n)
    + (limb2 << 128n)
    + (limb3 << 192n);
  
  return result;
}

/**
 * Safely divides two bigints and returns a JavaScript number with specified precision.
 * This avoids precision loss from converting large bigints to Number before division.
 * 
 * Algorithm:
 * 1. Scale numerator by 10^precision (in bigint arithmetic)
 * 2. Divide by denominator (in bigint arithmetic)
 * 3. Convert result to number
 * 
 * @param numerator - The dividend
 * @param denominator - The divisor
 * @param precision - Number of decimal places to preserve (default 18)
 * @returns The division result as a number
 */
export function divBigintToNumber(
  numerator: bigint,
  denominator: bigint,
  precision: number = 18
): number {
  if (denominator === 0n) {
    throw new Error("Division by zero");
  }
  
  // Scale numerator by 10^precision, then divide
  const scaleFactor = BigInt(10 ** precision);
  const scaled = (numerator * scaleFactor) / denominator;
  
  // Convert to number and scale back
  return Number(scaled) / (10 ** precision);
}

export function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  
  // Check if this is a BigFractionBytes (has value array)
  if (v && typeof v === "object") {
    if ("value" in v && Array.isArray((v as { value: unknown }).value)) {
      return bigFractionBytesToBigInt(v);
    }
    
    // Validate BN-like object more carefully
    if ("toString" in v && typeof (v as BNLike).toString === "function") {
      const str = (v as BNLike).toString();
      // Validate the string is numeric before converting
      if (/^-?\d+$/.test(str)) {
        return BigInt(str);
      }
    }
  }
  
  throw new Error(`Unsupported BN-like value: ${String(v)}`);
}

export function isZero(v: unknown): boolean {
  return toBigInt(v) === 0n;
}

export function gtZero(v: unknown): boolean {
  return toBigInt(v) > 0n;
}
