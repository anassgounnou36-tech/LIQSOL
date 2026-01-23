import { Connection, PublicKey } from "@solana/web3.js";
import crypto from "crypto";

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const programId = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

// Calculate Reserve discriminator
function anchorDiscriminator(accountName: string): Buffer {
  const hash = crypto.createHash("sha256");
  hash.update(`account:${accountName}`);
  return Buffer.from(hash.digest()).subarray(0, 8);
}

async function main() {
  const discriminator = anchorDiscriminator("Reserve");
  console.log("Reserve discriminator:", discriminator.toString("hex"));
  
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: discriminator.toString("base64"),
        },
      },
    ],
  });
  
  console.log(`Found ${accounts.length} Reserve accounts`);
  if (accounts.length > 0) {
    console.log("First 5 reserves:");
    accounts.slice(0, 5).forEach(({ pubkey }) => {
      console.log(pubkey.toString());
    });
  }
}

main().catch(console.error);
