# ShadowDesk - Confidential OTC Trading

Private over-the-counter trading powered by Fully Homomorphic Encryption (FHE) on Zama's fhEVM.

## Problem

Public blockchains expose all transaction data by default. In OTC trading, this transparency creates serious risks:

- **Front-running**: Bots detect large orders and trade ahead of them
- **Information leakage**: Competitors see your trading strategy, position sizes, and price levels
- **Market impact**: Visible large orders move prices before execution

## Solution

ShadowDesk encrypts order prices and amounts using FHE directly on-chain. Only authorized counterparties can decrypt trade details — everyone else sees encrypted data.

### How It Works

1. **Maker** creates an order with encrypted price and amount (token pair and direction are public)
2. The encrypted data lives on-chain — no one can read it without ACL permission
3. **Maker** can selectively grant view access to potential counterparties
4. **Taker** fills the order — encrypted details are revealed only to both parties
5. Both can decrypt and verify the trade on the **My Trades** page

## Tech Stack

- **Smart Contract**: Solidity + [fhEVM](https://docs.zama.ai/fhevm) (Zama's FHE-enabled EVM)
- **Encrypted Types**: `euint64` for price and amount, ACL-based access control
- **Frontend**: React + TypeScript + TailwindCSS + [fhevmjs](https://www.npmjs.com/package/fhevmjs)
- **Testing**: Hardhat + fhEVM mock environment
- **Network**: Ethereum Sepolia Testnet

## Deployed Contract

- **Network**: Sepolia
- **Address**: [`0x4f57A1d1Ec759b0CD13D87d0bfe2A2E949F6009f`](https://sepolia.etherscan.io/address/0x4f57A1d1Ec759b0CD13D87d0bfe2A2E949F6009f)

## Features

| Feature | Description |
|---------|-------------|
| Encrypted Orders | Price and amount are FHE-encrypted on-chain |
| ACL Access Control | Maker controls who can view order details |
| One-Click Fill | Taker fills order, both parties gain decryption access |
| Client-Side Decrypt | Users decrypt their own trade details in-browser via fhevmjs |
| Multiple Pairs | ETH/USDC, BTC/USDC, SOL/USDC, AVAX/USDC, MATIC/USDC |

## Smart Contract API

```solidity
createOrder(encPrice, priceProof, encAmount, amountProof, isBuy, tokenPair)
fillOrder(orderId)
cancelOrder(orderId)
grantAccess(orderId, viewer)
getOrder(orderId)        // public fields only
getPrice(orderId)        // ACL-gated
getAmount(orderId)       // ACL-gated
```

## Getting Started

### Prerequisites

- Node.js >= 20
- MetaMask with Sepolia ETH

### Smart Contract

```bash
npm install
npm run compile
npm test                    # 9 tests passing
npm run deploy:sepolia      # deploy to Sepolia
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env        # set VITE_CONTRACT_ADDRESS
npm run dev
```

## Testing

```
  ConfidentialOTC
    createOrder
      ✔ should create an order with encrypted price and amount
      ✔ maker should be able to decrypt their own order
    fillOrder
      ✔ should allow taker to fill an open order
      ✔ taker should be able to decrypt filled order details
      ✔ maker cannot fill own order
      ✔ cannot fill a non-open order
    cancelOrder
      ✔ maker can cancel their order
      ✔ non-maker cannot cancel order
    grantAccess
      ✔ maker can grant view access to third party

  9 passing
```

## Architecture

```
User Input (price, amount)
    ↓
fhevmjs encrypts → euint64 handles + proof
    ↓
ConfidentialOTC.createOrder() → stored on-chain as encrypted data
    ↓
fillOrder() → ACL grants taker access
    ↓
fhevmjs reencrypt → user decrypts in browser
```

## Why FHE for OTC?

Traditional privacy solutions (ZK-proofs, TEEs) have trade-offs. FHE is unique because:

- **Computation on encrypted data**: The contract can enforce rules without ever seeing plaintext
- **No trusted hardware**: Unlike TEEs, no special hardware requirements
- **Composable**: Other contracts can interact with encrypted values
- **Verifiable**: All operations are on-chain and auditable

## License

MIT
