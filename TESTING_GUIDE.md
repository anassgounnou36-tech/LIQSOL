# Testing Guide for snapshotObligations Fix

## Prerequisites
1. Create a `.env` file from `.env.example`:
   ```bash
   cp .env.example .env
   ```

2. Ensure the following environment variables are set in `.env`:
   ```
   RPC_PRIMARY=https://api.mainnet-beta.solana.com
   KAMINO_MARKET_PUBKEY=7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF
   KAMINO_KLEND_PROGRAM_ID=KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD
   ```

## Running the Snapshot Command

Execute the command:
```bash
npm run snapshot:obligations
```

## Expected Behavior

### 1. Initial Logs
You should see logs indicating:
- Starting obligation snapshot
- Using Obligation discriminator
- Fetching obligation account pubkeys

### 2. Progress Logs
For each batch of 100 accounts, you should see:
```
Fetching account data batch { chunk: 1, total: X, accounts: 100 }
Fetching account data batch { chunk: 2, total: X, accounts: 100 }
...
```

### 3. Final Logs
- Count of filtered obligations by market
- Snapshot complete with output path and count
- All pubkeys validated as valid base58

### 4. Output File
- File created at: `data/obligations.jsonl`
- Contains one pubkey per line
- All entries are valid base58 Solana pubkeys

## Success Criteria

✅ Command completes without `ERR_STRING_TOO_LONG` error
✅ Progress logs show batch processing
✅ Output file `data/obligations.jsonl` is created
✅ File contains non-zero count of valid base58 pubkeys
✅ Each line in the file is exactly 44 characters (base58 pubkey length)

## Troubleshooting

### Rate Limiting
If you see rate limiting errors from the RPC, consider:
- Using a different RPC provider
- Adding delays between batch fetches (would require code modification)

### No Obligations Found
If the output shows 0 obligations:
- Verify `KAMINO_MARKET_PUBKEY` is correct
- Check that the market has active obligations

### Invalid Pubkeys
If validation fails:
- Check the output file for malformed entries
- Review logs for decoding errors

## Verification Commands

Check output file:
```bash
cat data/obligations.jsonl | wc -l
```

Validate first few pubkeys:
```bash
head -5 data/obligations.jsonl
```

Count total pubkeys:
```bash
wc -l data/obligations.jsonl
```
