type BNLike = { toString(): string };

export function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  if (v && typeof (v as BNLike).toString === "function") return BigInt((v as BNLike).toString());
  throw new Error(`Unsupported BN-like value: ${String(v)}`);
}

export function isZero(v: unknown): boolean {
  return toBigInt(v) === 0n;
}

export function gtZero(v: unknown): boolean {
  return toBigInt(v) > 0n;
}
