import crypto from "node:crypto";

export function anchorDiscriminator(name: string): Buffer {
  const preimage = `account:${name}`;
  const hash = crypto.createHash("sha256").update(preimage).digest();
  return hash.subarray(0, 8);
}

export function hasDiscriminator(data: Buffer, name: string): boolean {
  if (data.length < 8) return false;
  const disc = anchorDiscriminator(name);
  return data.subarray(0, 8).equals(disc);
}
