import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMintObligationMapping } from "../src/monitoring/mintObligationMapping.js";

describe("mint obligation mapping fallback", () => {
  const originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "liqsol-mapping-"));
    fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("falls back to candidates when queue file exists but is an empty array", () => {
    fs.writeFileSync(path.join(tempDir, "data", "tx_queue.json"), "[]");
    fs.writeFileSync(
      path.join(tempDir, "data", "candidates.json"),
      JSON.stringify({ data: [{ key: "obligation-1", assets: ["mint-1"] }] })
    );

    const { mintToKeys, keyToMints } = buildMintObligationMapping();
    expect(mintToKeys.get("mint-1")?.has("obligation-1")).toBe(true);
    expect(keyToMints.get("obligation-1")?.has("mint-1")).toBe(true);
  });

  it("falls back to candidates.candidates when queue.data is empty", () => {
    fs.writeFileSync(path.join(tempDir, "data", "tx_queue.json"), JSON.stringify({ data: [] }));
    fs.writeFileSync(
      path.join(tempDir, "data", "candidates.json"),
      JSON.stringify({ candidates: [{ obligationPubkey: "obligation-2", assets: ["mint-2"] }] })
    );

    const { mintToKeys, keyToMints } = buildMintObligationMapping();
    expect(mintToKeys.get("mint-2")?.has("obligation-2")).toBe(true);
    expect(keyToMints.get("obligation-2")?.has("mint-2")).toBe(true);
  });
});
