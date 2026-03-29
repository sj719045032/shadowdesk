import { useState, useEffect, useMemo } from "react";
import { fetchAllOrders, type OrderData, getContract, CONTRACT_ADDRESS } from "../lib/contract";
import { useWallet } from "../App";
import { decryptValues } from "../lib/fhevm";

type DecryptedOrder = OrderData & {
  decryptedPrice?: number;
  decryptedAmount?: number;
  decrypting?: boolean;
  justDecrypted?: boolean;
};

export default function MyTrades() {
  const { account, connect } = useWallet();
  const [orders, setOrders] = useState<DecryptedOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (account) loadMyOrders();
  }, [account]);

  async function loadMyOrders() {
    try {
      setLoading(true);
      const all = await fetchAllOrders();
      // Note: taker is now encrypted (eaddress), so we can only filter by maker
      // In a full implementation, we'd also track fills per taker address
      const mine = all.filter(
        (o) => o.maker.toLowerCase() === account.toLowerCase(),
      );
      setOrders(mine.reverse());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  async function handleDecrypt(orderId: number) {
    try {
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, decrypting: true } : o)),
      );

      const contract = await getContract();
      const encPrice = await contract.getPrice(orderId);
      const encAmount = await contract.getAmount(orderId);

      const results = await decryptValues(
        [
          { handle: encPrice.toString(), contractAddress: CONTRACT_ADDRESS },
          { handle: encAmount.toString(), contractAddress: CONTRACT_ADDRESS },
        ],
        account,
      );

      const values = [...results.values()];

      setOrders((prev) =>
        prev.map((o) =>
          o.id === orderId
            ? {
                ...o,
                decryptedPrice: Number(values[0] || 0n),
                decryptedAmount: Number(values[1] || 0n),
                decrypting: false,
                justDecrypted: true,
              }
            : o,
        ),
      );

      // Remove the animation flag after it plays
      setTimeout(() => {
        setOrders((prev) =>
          prev.map((o) =>
            o.id === orderId ? { ...o, justDecrypted: false } : o,
          ),
        );
      }, 700);
    } catch (err) {
      console.error("Decrypt failed:", err);
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, decrypting: false } : o)),
      );
    }
  }

  // Portfolio value from decrypted orders
  const portfolioValue = useMemo(() => {
    let total = 0;
    let hasDecrypted = false;
    orders.forEach((o) => {
      if (o.decryptedPrice !== undefined && o.decryptedAmount !== undefined) {
        total += o.decryptedPrice * o.decryptedAmount;
        hasDecrypted = true;
      }
    });
    return { total, hasDecrypted };
  }, [orders]);

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-blue-500/10 mb-5">
          <svg className="shield-pulse" width="36" height="36" viewBox="0 0 32 32" fill="none">
            <path d="M16 2L4 8v8c0 7.18 5.12 13.9 12 16 6.88-2.1 12-8.82 12-16V8L16 2z" fill="#3b82f6" fillOpacity="0.15" stroke="#3b82f6" strokeWidth="1.5"/>
            <rect x="12" y="13" width="8" height="7" rx="1" stroke="#3b82f6" strokeWidth="1.5"/>
            <path d="M14 13v-2a2 2 0 014 0v2" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
        <div className="text-slate-200 font-semibold text-lg mb-2">Wallet Required</div>
        <div className="text-slate-500 text-sm mb-5 text-center max-w-xs">Connect your wallet to view and decrypt your trades</div>
        <button
          onClick={connect}
          className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white px-6 py-2.5 rounded-full text-sm font-medium transition-all duration-200 shadow-[0_0_20px_rgba(59,130,246,0.3)] cursor-pointer"
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">My Trades</h1>
          <p className="text-slate-400 text-sm mt-1">
            Orders you created or filled. Decrypt to reveal hidden details.
          </p>
        </div>
        <button
          onClick={loadMyOrders}
          className="self-start flex items-center gap-1.5 text-xs text-slate-400 hover:text-blue-400 border border-[#1e293b] hover:border-blue-500/30 rounded-lg px-3 py-1.5 transition-all duration-200 cursor-pointer"
        >
          <svg className={loading ? "spinner" : ""} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m0 0a9 9 0 019-9m-9 9a9 9 0 009 9"/>
          </svg>
          Refresh
        </button>
      </div>

      {/* Portfolio Value */}
      {portfolioValue.hasDecrypted && (
        <div className="mb-6 rounded-xl overflow-hidden gradient-border card-glow">
          <div className="bg-gradient-to-r from-[#111827] to-[#0f172a] p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
              </svg>
              <span className="text-xs text-slate-400 uppercase tracking-wider font-medium">Decrypted Portfolio Value</span>
            </div>
            <div className="stat-value text-3xl sm:text-4xl font-bold text-white">
              ${portfolioValue.total.toLocaleString()}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Based on {orders.filter((o) => o.decryptedPrice !== undefined).length} decrypted order{orders.filter((o) => o.decryptedPrice !== undefined).length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full spinner" />
          <span className="text-slate-400 text-sm">Loading your trades...</span>
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-20">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-800/50 mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/>
            </svg>
          </div>
          <div className="text-slate-300 font-medium mb-1">No trades yet</div>
          <div className="text-slate-500 text-sm">Create or fill an order to see it here.</div>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((o, idx) => (
            <div
              key={o.id}
              className="bg-[#111827] border border-[#1e293b] rounded-xl overflow-hidden gradient-border row-enter hover:border-blue-500/10 transition-colors duration-300"
              style={{ animationDelay: `${idx * 60}ms` }}
            >
              <div className="p-5 sm:p-6">
                {/* Top row: ID, pair, side, status, role */}
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-slate-500 bg-[#0d1117] px-2 py-0.5 rounded">#{o.id}</span>
                    <span className="font-bold text-slate-100">{o.tokenPair}</span>
                    <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded ${
                      o.isBuy
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-red-500/10 text-red-400"
                    }`}>
                      {o.isBuy ? "BUY" : "SELL"}
                    </span>
                    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full ${
                      o.status === 0
                        ? "bg-emerald-500/10 text-emerald-400 status-open"
                        : o.status === 1
                          ? "bg-blue-500/10 text-blue-400"
                          : "bg-slate-500/10 text-slate-500"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        o.status === 0 ? "bg-emerald-400" : o.status === 1 ? "bg-blue-400" : "bg-slate-500"
                      }`} />
                      {["Open", "Filled", "Cancelled"][o.status]}
                    </span>
                  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                    o.maker.toLowerCase() === account.toLowerCase()
                      ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                      : "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                  }`}>
                    {o.maker.toLowerCase() === account.toLowerCase() ? "Maker" : "Taker"}
                  </span>
                </div>

                {/* Price & Amount */}
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="bg-[#0d1117] rounded-lg p-3 border border-[#1e293b]/50">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 font-medium">Price</div>
                    {o.decryptedPrice !== undefined ? (
                      <div className={`text-xl font-bold text-emerald-400 ${o.justDecrypted ? "decrypt-reveal" : ""}`}>
                        ${o.decryptedPrice.toLocaleString()}
                      </div>
                    ) : (
                      <div className="encrypted-badge inline-flex items-center gap-1.5 border border-blue-500/20 rounded-md px-2.5 py-1 text-xs text-blue-300/80">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                        Encrypted
                      </div>
                    )}
                  </div>
                  <div className="bg-[#0d1117] rounded-lg p-3 border border-[#1e293b]/50">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 font-medium">Amount</div>
                    {o.decryptedAmount !== undefined ? (
                      <div className={`text-xl font-bold text-emerald-400 ${o.justDecrypted ? "decrypt-reveal" : ""}`}>
                        {o.decryptedAmount.toLocaleString()} <span className="text-sm text-slate-400">{o.tokenPair.split("/")[0]}</span>
                      </div>
                    ) : (
                      <div className="encrypted-badge inline-flex items-center gap-1.5 border border-blue-500/20 rounded-md px-2.5 py-1 text-xs text-blue-300/80">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                        Encrypted
                      </div>
                    )}
                  </div>
                </div>

                {/* Decrypt button */}
                {o.decryptedPrice === undefined && (
                  <button
                    onClick={() => handleDecrypt(o.id)}
                    disabled={o.decrypting}
                    className="w-full bg-gradient-to-r from-[#0d1117] to-[#111827] hover:from-blue-500/10 hover:to-blue-500/5 border border-[#1e293b] hover:border-blue-500/30 text-slate-300 py-3 rounded-xl text-sm font-medium transition-all duration-200 disabled:opacity-50 cursor-pointer group"
                  >
                    {o.decrypting ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-blue-400/30 border-t-blue-400 rounded-full spinner" />
                        <span className="text-blue-400">Decrypting...</span>
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2 group-hover:text-blue-400 transition-colors">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                          <path d="M7 11V7a5 5 0 019.9-1"/>
                        </svg>
                        Decrypt Details
                      </span>
                    )}
                  </button>
                )}

                {/* Total value (after decrypt) */}
                {o.decryptedPrice !== undefined && o.decryptedAmount !== undefined && (
                  <div className={`flex justify-between items-center text-sm pt-3 mt-1 border-t border-[#1e293b]/50 ${o.justDecrypted ? "decrypt-reveal" : ""}`}>
                    <span className="text-slate-400">Total Value</span>
                    <span className="font-bold text-lg text-blue-400">
                      ${(o.decryptedPrice * o.decryptedAmount).toLocaleString()} <span className="text-xs text-slate-500">{o.tokenPair.split("/")[1]}</span>
                    </span>
                  </div>
                )}

                {/* Counterparty info */}
                {o.status === 1 && (
                  <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[#1e293b]/50 text-xs text-slate-500">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
                    </svg>
                    <span>
                      Counterparty: <span className="font-mono text-slate-400">Encrypted (eaddress)</span>
                    </span>
                  </div>
                )}

                {/* Timestamp */}
                <div className="flex items-center gap-2 mt-2 text-xs text-slate-600">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  {new Date(o.createdAt * 1000).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
