# ShadowOTC - Confidential OTC Dark Pool

Private over-the-counter trading powered by Fully Homomorphic Encryption (FHE) on Zama's fhEVM. All prices, amounts, and counterparty identities are encrypted on-chain -- no one (not even validators) can see your trading data.

## Problem

OTC trading on public blockchains exposes prices, amounts, and counterparties to everyone. This transparency creates serious risks:

- **Front-running**: MEV bots detect large orders in the mempool and trade ahead of them
- **Information leakage**: Competitors see your trading strategy, position sizes, and price levels in real time
- **Market impact**: Visible large orders move prices before execution completes
- **Counterparty exposure**: On-chain observers can link trading addresses and build profiles

Traditional privacy approaches (mixers, ZK-proofs, TEEs) either break composability, require trusted hardware, or only hide the sender -- not the trade details.

## Solution

ShadowOTC uses FHE-encrypted price matching with three-phase settlement to keep every aspect of a trade confidential while still settling trustlessly on-chain.

- Prices and amounts are encrypted as `euint64` values -- the contract operates on ciphertext, never plaintext
- Counterparty addresses are stored as `eaddress` for full privacy
- ACL-gated decryption lets makers selectively reveal terms to potential takers
- Confidential wrapper tokens (cWETH, cUSDC) built on ERC-7984 enable encrypted escrow and transfers

## Architecture Diagram

```
User --> Wrap ETH/USDC --> cWETH/cUSDC (ERC-7984 confidential wrappers)
                               |
Create Order --> FHE encrypt price & amount --> Store encrypted on-chain
                               |
Taker --> Request Access --> Maker grants ACL --> Taker decrypts terms
                               |
Initiate Fill --> FHE price matching (15 ops) --> Mark for public decrypt
                               |
Settle Fill --> Verify decryption proof --> Execute cWETH <-> cUSDC swap
```

## FHE Operations (17-18 total)

ShadowOTC exercises a wide range of fhEVM operations across the fill lifecycle:

| Operation | Count | Purpose |
|-----------|-------|---------|
| `FHE.ge` | 1 | Price comparison: taker price >= maker price |
| `FHE.min` | 1 | Cap fill amount to remaining order amount |
| `FHE.sub` | 1 | Reduce remaining amount after fill |
| `FHE.mul` | 1 | Compute quote total = fill amount * price |
| `FHE.add` | 1 | Accumulate total encrypted volume |
| `FHE.select` | 2 | Conditionally zero out amounts on price mismatch |
| `FHE.randEuint64` | 1 | Fair tiebreaking via on-chain FHE randomness |
| `FHE.eq` | 2 | Check zero amounts (mismatch detection) |
| `FHE.gt` | 1 | Priority score comparison |
| `FHE.and` | 1 | Combine boolean conditions |
| `FHE.asEaddress` | 1 | Encrypt taker address for counterparty privacy |
| `FHE.asEuint64` | 1 | Convert plaintext to encrypted type |
| `FHE.allowTransient` | 1 | Temporary ACL for cross-contract transfers |
| `FHE.makePubliclyDecryptable` | 3 | Mark fill amount, quote total, and match flag for public decryption |
| `FHE.checkSignatures` | 1 | Verify encrypted input proofs |

## Three-Phase Settlement

Settlement follows a two-transaction, three-phase pattern using Zama's public decryption mechanism:

### Phase 1: Initiate Fill (`initiateFill`)

The taker submits encrypted bid price and amount. The contract performs all FHE computation in a single transaction:

1. Verify taker's encrypted inputs (`checkSignatures`)
2. Compare prices: `takerPrice >= makerPrice` (`ge`)
3. Compute effective fill amount: `min(takerAmount, remainingAmount)` (`min`)
4. Conditionally zero amounts on price mismatch (`select`)
5. Compute settlement totals: `fillAmount * price` (`mul`)
6. Update order remaining: `remaining - fillAmount` (`sub`)
7. Accumulate volume: `totalVolume + quoteTotal` (`add`)
8. Generate priority score for fair ordering (`randEuint64`)
9. Encrypt taker address (`asEaddress`)
10. Mark results for public decryption (`makePubliclyDecryptable` x3)

### Phase 2: Public Decryption (off-chain relay)

The Zama gateway decryption relayer picks up the `makePubliclyDecryptable` requests, decrypts the marked values, and produces a proof. This happens automatically off-chain.

### Phase 3: Settle Fill (`settleFill`)

The settlement transaction verifies the decryption proof and executes or cancels transfers:

- If price matched (fill amount > 0): transfer cWETH and cUSDC between maker and taker
- If price mismatched (fill amount = 0): refund taker's deposit, no state change
- Emit `FillSettled` event with public transfer amounts

This pattern ensures FHE computation and token transfers never happen in the same transaction, avoiding gas limit issues and enabling clean error recovery.

## Comparison with Existing Projects

| Feature | ShadowOTC | OTC-with-FHE | fhe-darkpools |
|---------|-----------|--------------|---------------|
| Encrypted prices | euint64 | euint64 | euint32 |
| Encrypted amounts | euint64 | None (public) | euint32 |
| Encrypted counterparty | eaddress | None | None |
| Price matching | On-chain FHE | On-chain FHE | Off-chain |
| Partial fills | Yes | No | No |
| Confidential tokens | cWETH + cUSDC (ERC-7984) | Plain ERC-20 | Plain ERC-20 |
| Settlement model | 3-phase (initiate/decrypt/settle) | 1-phase | 1-phase |
| FHE operations used | 17-18 | 3-4 | 2-3 |
| Fair ordering | FHE randomness | None | None |
| Compliance/audit | Auditor ACL access | None | None |
| Post-trade transparency | Published fill volumes | None | None |
| Test coverage | 80+ tests | <10 | <10 |

## Tech Stack

- **Smart Contracts**: Solidity + [fhEVM](https://docs.zama.ai/fhevm) (Zama)
- **Encrypted Types**: `euint64` for price/amount, `eaddress` for counterparty, `ebool` for match flags
- **Confidential Tokens**: cWETH + cUSDC built on ERC-7984
- **Frontend**: React + TypeScript + TailwindCSS + [fhevmjs](https://www.npmjs.com/package/fhevmjs) (Zama Relayer SDK)
- **Testing**: Hardhat + fhEVM mock environment, 80+ tests
- **Network**: Ethereum Sepolia Testnet

## Deployed Contracts

| Contract | Address |
|----------|---------|
| ConfidentialOTC | `TBD` |
| cWETH (ERC-7984) | `TBD` |
| cUSDC (ERC-7984) | `TBD` |

> Deploy with `npm run deploy:sepolia` and update `.env` files with the new addresses.

## Getting Started

### Prerequisites

- Node.js >= 20
- MetaMask with Sepolia ETH
- Sepolia testnet USDC and ETH for wrapping

### Smart Contracts

```bash
# Install dependencies
npm install

# Compile contracts
npm run compile

# Run tests (80+ passing)
npm test

# Deploy to Sepolia
npm run deploy:sepolia
```

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env: set VITE_CONTRACT_ADDRESS, VITE_CWETH_ADDRESS, VITE_CUSDC_ADDRESS

# Start dev server
npm run dev

# Production build
npm run build
```

### Usage Flow

1. **Wrap tokens**: Deposit ETH or USDC to get cWETH or cUSDC via the Vault page
2. **Create order**: Set encrypted price and amount, choose BUY or SELL, deposit collateral
3. **Share with counterparty**: Grant ACL access so the taker can decrypt your terms
4. **Fill order**: Taker decrypts, reviews terms, then initiates a two-step fill:
   - TX1: `initiateFill` -- encrypts bid, runs FHE price matching on-chain
   - TX2: `settleFill` -- verifies decryption proof, executes token swap
5. **Verify**: Both parties can decrypt and verify fill details on the My Trades page

## Production Roadmap

- Fully encrypted transfer amounts (euint64) for complete settlement privacy
- Gateway async decryption for hard failure on insufficient balance
- Multi-pair support (cBTC, cSOL, cARB, etc.)
- Upgradeable proxy contracts (UUPS pattern)
- Order expiry with automatic refund
- Batch fills for multiple takers per order
- Cross-chain settlement via confidential bridges

## License

MIT
