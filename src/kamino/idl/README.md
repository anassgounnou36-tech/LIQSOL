# Kamino Lending (klend) IDL

## Source Information

**Program ID (Mainnet):** `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`

**IDL Version:** 1.12.6

**Source:** Extracted from `@kamino-finance/klend-sdk` version 7.3.9

**Repository:** https://github.com/Kamino-Finance/klend-sdk

**IDL File:** The `klend.json` file in this directory is sourced from:
- Package: `@kamino-finance/klend-sdk@7.3.9`
- Path: `src/idl/klend.json` within the package
- Commit/Tag: Corresponds to npm package version 7.3.9

This IDL file is used by the Anchor BorshAccountsCoder to decode Reserve and Obligation accounts from the Kamino Lending protocol.

## Account Types

- **Reserve**: Contains reserve configuration, liquidity, collateral, and pricing information
- **Obligation**: Contains user obligation data including deposits (collateral) and borrows
