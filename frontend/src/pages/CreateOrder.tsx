import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getContract } from "../lib/contract";
import { encryptInputs } from "../lib/fhevm";
import { useWallet } from "../App";

const TOKEN_PAIRS = ["ETH/USDC", "BTC/USDC", "SOL/USDC", "AVAX/USDC", "MATIC/USDC"];

export default function CreateOrder() {
  const { account, connect } = useWallet();
  const navigate = useNavigate();
  const [pair, setPair] = useState("ETH/USDC");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!account) {
      await connect();
      return;
    }

    const priceNum = Number(price);
    const amountNum = Number(amount);
    if (!priceNum || !amountNum) {
      setError("Price and amount must be greater than 0");
      return;
    }

    try {
      setSubmitting(true);

      // Encrypt price and amount using fhEVM
      const encrypted = await encryptInputs(account, priceNum, amountNum);

      const contract = await getContract(true);
      const tx = await contract.createOrder(
        encrypted.handles[0],
        encrypted.inputProof,
        encrypted.handles[1],
        encrypted.inputProof,
        side === "buy",
        pair,
      );
      await tx.wait();
      navigate("/");
    } catch (err: unknown) {
      console.error(err);
      setError((err as Error).message?.slice(0, 100) || "Transaction failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold mb-2">Create Order</h1>
      <p className="text-slate-400 text-sm mb-8">
        Your price and amount will be encrypted on-chain using FHE. No one can see your order details until you grant access.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Token Pair */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Token Pair</label>
          <div className="flex flex-wrap gap-2">
            {TOKEN_PAIRS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPair(p)}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition cursor-pointer ${
                  pair === p
                    ? "border-blue-500 bg-blue-500/20 text-blue-400"
                    : "border-[#2a3a52] bg-[#1a2235] text-slate-400 hover:border-slate-500"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Side */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">Side</label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setSide("buy")}
              className={`py-3 rounded-lg text-sm font-bold border-2 transition cursor-pointer ${
                side === "buy"
                  ? "border-green-500 bg-green-500/20 text-green-400"
                  : "border-[#2a3a52] bg-[#1a2235] text-slate-400"
              }`}
            >
              BUY
            </button>
            <button
              type="button"
              onClick={() => setSide("sell")}
              className={`py-3 rounded-lg text-sm font-bold border-2 transition cursor-pointer ${
                side === "sell"
                  ? "border-red-500 bg-red-500/20 text-red-400"
                  : "border-[#2a3a52] bg-[#1a2235] text-slate-400"
              }`}
            >
              SELL
            </button>
          </div>
        </div>

        {/* Price */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Price (USD)
            <span className="ml-2 text-xs text-slate-500">🔒 Will be encrypted</span>
          </label>
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            min="1"
            className="w-full bg-[#1a2235] border border-[#2a3a52] rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
          />
        </div>

        {/* Amount */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Amount
            <span className="ml-2 text-xs text-slate-500">🔒 Will be encrypted</span>
          </label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            min="1"
            className="w-full bg-[#1a2235] border border-[#2a3a52] rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
          />
        </div>

        {/* Summary */}
        {price && amount && (
          <div className="bg-[#1a2235] border border-[#2a3a52] rounded-lg p-4">
            <div className="text-xs text-slate-400 mb-2">Order Summary</div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-300">{side === "buy" ? "Buying" : "Selling"}</span>
              <span className="font-medium">{amount} {pair.split("/")[0]}</span>
            </div>
            <div className="flex justify-between text-sm mt-1">
              <span className="text-slate-300">@ Price</span>
              <span className="font-medium">${price} {pair.split("/")[1]}</span>
            </div>
            <div className="flex justify-between text-sm mt-1 pt-2 border-t border-[#2a3a52]">
              <span className="text-slate-300">Total</span>
              <span className="font-bold text-blue-400">
                ${(Number(price) * Number(amount)).toLocaleString()} {pair.split("/")[1]}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
              <span>🔒</span>
              <span>Price, amount, and total will be encrypted before submission</span>
            </div>
          </div>
        )}

        {error && <div className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg p-3">{error}</div>}

        <button
          type="submit"
          disabled={submitting || !price || !amount}
          className="w-full bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 rounded-lg font-medium transition cursor-pointer"
        >
          {submitting
            ? "Encrypting & Submitting..."
            : !account
              ? "Connect Wallet"
              : "Create Encrypted Order"}
        </button>
      </form>
    </div>
  );
}
