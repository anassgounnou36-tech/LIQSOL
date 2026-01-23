type BNLike = { toString(): string };

export function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  // Validate BN-like object more carefully
  if (v && typeof v === "object" && "toString" in v && typeof (v as BNLike).toString === "function") {
    const str = (v as BNLike).toString();
    // Validate the string is numeric before converting
    if (/^-?\d+$/.test(str)) {
      return BigInt(str);
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
