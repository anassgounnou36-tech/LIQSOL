import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { KAMINO_DISCRIMINATORS } from "../execute/decodeKaminoKindFromCompiled.js";

function disc(name: string): string {
  return createHash("sha256").update(`global:${name}`).digest("hex").slice(0, 16);
}

describe("KAMINO_DISCRIMINATORS", () => {
  it("matches Anchor snake_case discriminators", () => {
    expect(disc("refresh_reserve")).toBe(KAMINO_DISCRIMINATORS.refreshReserve);
    expect(disc("refresh_obligation")).toBe(KAMINO_DISCRIMINATORS.refreshObligation);
    expect(disc("liquidate_obligation_and_redeem_reserve_collateral")).toBe(
      KAMINO_DISCRIMINATORS.liquidateObligationAndRedeemReserveCollateral
    );
    expect(disc("refresh_obligation_farms_for_reserve")).toBe(
      KAMINO_DISCRIMINATORS.refreshObligationFarmsForReserve
    );
    expect(disc("flash_borrow_reserve_liquidity")).toBe(KAMINO_DISCRIMINATORS.flashBorrowReserveLiquidity);
    expect(disc("flash_repay_reserve_liquidity")).toBe(KAMINO_DISCRIMINATORS.flashRepayReserveLiquidity);
  });
});
