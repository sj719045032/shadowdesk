import { useState, useEffect, useMemo } from "react";
import { fetchAllOrders, type OrderData, getContract } from "../lib/contract";
import { useWallet } from "../App";
import { encryptInputs } from "../lib/fhevm";

const STATUS_LABELS = ["Open", "Filled", "Cancelled"];

type FilterSide = "all" | "buy" | "sell";
type FilterStatus = "all" | "0" | "1" | "2";

export default function OrderBook() {
  const { account, connect } = useWallet();
  const [orders, setOrders] = useState<OrderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filling, setFilling] = useState<number | null>(null);

  // Filters
  const [filterPair, setFilterPair] = useState("all");
  const [filterSide, setFilterSide] = useState<FilterSide>("all");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");

  useEffect(() => {
    loadOrders();
  }, []);

  async function loadOrders() {
    try {
      setLoading(true);
      const data = await fetchAllOrders();
      setOrders(data.reverse());
    } catch {
      // contract not deployed or no wallet
    } finally {
      setLoading(false);
    }
  }

  async function handleFill(orderId: number) {
    if (!account) {
      await connect();
      return;
    }
    try {
      setFilling(orderId);
      // For demo: taker offers a high price (999999) and amount (999999) to ensure match
      // In production, taker would input their own price/amount
      const encrypted = await encryptInputs(account, 999999, 999999);
      const contract = await getContract(true);
      const tx = await contract.fillOrder(
        orderId,
        encrypted.handles[0],
        encrypted.inputProof,
        encrypted.handles[1],
        encrypted.inputProof,
      );
      await tx.wait();
      await loadOrders();
    } catch (err) {
      console.error("Fill failed:", err);
    } finally {
      setFilling(null);
    }
  }

  // Derived values
  const pairs = useMemo(() => [...new Set(orders.map((o) => o.tokenPair))], [orders]);
  const openCount = useMemo(() => orders.filter((o) => o.status === 0).length, [orders]);
  const filledCount = useMemo(() => orders.filter((o) => o.status === 1).length, [orders]);

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (filterPair !== "all" && o.tokenPair !== filterPair) return false;
      if (filterSide !== "all" && (filterSide === "buy" ? !o.isBuy : o.isBuy)) return false;
      if (filterStatus !== "all" && o.status !== Number(filterStatus)) return false;
      return true;
    });
  }, [orders, filterPair, filterSide, filterStatus]);

  return (
    <div>
      {/* Hero Banner */}
      <div className="relative overflow-hidden rounded-2xl mb-8 gradient-border">
        {/* Background layers */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#0f172a] via-[#111827] to-[#0f172a]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(59,130,246,0.08),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,rgba(34,197,94,0.05),transparent_60%)]" />

        <div className="relative px-6 sm:px-8 py-8 sm:py-10">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
            {/* Left: Tagline */}
            <div className="max-w-xl">
              <div className="flex items-center gap-2 mb-3">
                <svg className="shield-pulse" width="20" height="20" viewBox="0 0 32 32" fill="none">
                  <path d="M16 2L4 8v8c0 7.18 5.12 13.9 12 16 6.88-2.1 12-8.82 12-16V8L16 2z" fill="url(#sh2)" fillOpacity="0.2" stroke="url(#sh2)" strokeWidth="1.5"/>
                  <path d="M12 16l3 3 5-6" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <defs><linearGradient id="sh2" x1="4" y1="2" x2="28" y2="26"><stop stopColor="#3b82f6"/><stop offset="1" stopColor="#22c55e"/></linearGradient></defs>
                </svg>
                <span className="text-xs font-semibold uppercase tracking-widest text-blue-400/80">Confidential Dark Pool</span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2 leading-tight">
                Trade with <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-cyan-300">Full Encryption</span>
              </h1>
              <p className="text-slate-400 text-sm leading-relaxed">
                All order prices and amounts are encrypted on-chain using Fully Homomorphic Encryption.
                No one -- not even validators -- can see your trading data.
              </p>
            </div>

            {/* Right: Stats */}
            <div className="grid grid-cols-3 gap-3 sm:gap-4">
              <div className="bg-[#0a0e17]/60 backdrop-blur rounded-xl px-4 py-4 text-center border border-[#1e293b]">
                <div className="stat-value text-2xl sm:text-3xl font-bold text-blue-400">{orders.length}</div>
                <div className="text-[10px] sm:text-xs text-slate-500 mt-1 uppercase tracking-wider">Total Orders</div>
              </div>
              <div className="bg-[#0a0e17]/60 backdrop-blur rounded-xl px-4 py-4 text-center border border-[#1e293b]">
                <div className="stat-value text-2xl sm:text-3xl font-bold text-emerald-400">{filledCount}</div>
                <div className="text-[10px] sm:text-xs text-slate-500 mt-1 uppercase tracking-wider">Filled</div>
              </div>
              <div className="bg-[#0a0e17]/60 backdrop-blur rounded-xl px-4 py-4 text-center border border-[#1e293b]">
                <div className="stat-value text-2xl sm:text-3xl font-bold text-amber-400">{openCount}</div>
                <div className="text-[10px] sm:text-xs text-slate-500 mt-1 uppercase tracking-wider">Open</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
          </svg>
          Filter
        </div>

        {/* Pair filter */}
        <select
          value={filterPair}
          onChange={(e) => setFilterPair(e.target.value)}
          className="bg-[#111827] border border-[#1e293b] text-slate-300 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500/50 transition cursor-pointer"
        >
          <option value="all">All Pairs</option>
          {pairs.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        {/* Side filter */}
        <select
          value={filterSide}
          onChange={(e) => setFilterSide(e.target.value as FilterSide)}
          className="bg-[#111827] border border-[#1e293b] text-slate-300 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500/50 transition cursor-pointer"
        >
          <option value="all">All Sides</option>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>

        {/* Status filter */}
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
          className="bg-[#111827] border border-[#1e293b] text-slate-300 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500/50 transition cursor-pointer"
        >
          <option value="all">All Status</option>
          <option value="0">Open</option>
          <option value="1">Filled</option>
          <option value="2">Cancelled</option>
        </select>

        <div className="flex-1" />

        <button
          onClick={loadOrders}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-blue-400 border border-[#1e293b] hover:border-blue-500/30 rounded-lg px-3 py-1.5 transition-all duration-200 cursor-pointer"
        >
          <svg className={loading ? "spinner" : ""} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m0 0a9 9 0 019-9m-9 9a9 9 0 009 9"/>
          </svg>
          Refresh
        </button>
      </div>

      {/* Order Table */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full spinner" />
          <span className="text-slate-400 text-sm">Loading encrypted orders...</span>
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-20">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-500/10 mb-4">
            <svg className="shield-pulse" width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path d="M16 2L4 8v8c0 7.18 5.12 13.9 12 16 6.88-2.1 12-8.82 12-16V8L16 2z" fill="#3b82f6" fillOpacity="0.15" stroke="#3b82f6" strokeWidth="1.5"/>
              <path d="M12 16l3 3 5-6" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="text-slate-300 font-medium mb-1">No orders yet</div>
          <div className="text-slate-500 text-sm">Be the first to create an encrypted order.</div>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block rounded-xl overflow-hidden gradient-border card-glow">
            <div className="bg-[#0d1117] overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-[#111827]/80 text-slate-500 text-[11px] uppercase tracking-wider">
                    <th className="text-left px-4 py-3 font-semibold">ID</th>
                    <th className="text-left px-4 py-3 font-semibold">Pair</th>
                    <th className="text-left px-4 py-3 font-semibold">Side</th>
                    <th className="text-left px-4 py-3 font-semibold">Price</th>
                    <th className="text-left px-4 py-3 font-semibold">Amount</th>
                    <th className="text-left px-4 py-3 font-semibold">Maker</th>
                    <th className="text-left px-4 py-3 font-semibold">Status</th>
                    <th className="text-left px-4 py-3 font-semibold">Time</th>
                    <th className="text-right px-4 py-3 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map((o, idx) => (
                    <tr
                      key={o.id}
                      className="border-t border-[#1e293b]/60 hover:bg-blue-500/[0.03] transition-colors duration-200 row-enter"
                      style={{ animationDelay: `${idx * 40}ms` }}
                    >
                      <td className="px-4 py-3.5 font-mono text-xs text-slate-400">#{o.id}</td>
                      <td className="px-4 py-3.5">
                        <span className="font-semibold text-sm text-slate-200">{o.tokenPair}</span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded ${
                          o.isBuy
                            ? "bg-emerald-500/10 text-emerald-400"
                            : "bg-red-500/10 text-red-400"
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${o.isBuy ? "bg-emerald-400" : "bg-red-400"}`} />
                          {o.isBuy ? "BUY" : "SELL"}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="encrypted-badge inline-flex items-center gap-1.5 border border-blue-500/20 rounded-md px-2.5 py-1 text-xs text-blue-300/80">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                            <path d="M7 11V7a5 5 0 0110 0v4"/>
                          </svg>
                          Encrypted
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="encrypted-badge inline-flex items-center gap-1.5 border border-blue-500/20 rounded-md px-2.5 py-1 text-xs text-blue-300/80">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                            <path d="M7 11V7a5 5 0 0110 0v4"/>
                          </svg>
                          Encrypted
                        </span>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs text-slate-500">
                        {o.maker.slice(0, 6)}...{o.maker.slice(-4)}
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full ${
                          o.status === 0
                            ? "bg-emerald-500/10 text-emerald-400 status-open"
                            : o.status === 1
                              ? "bg-blue-500/10 text-blue-400"
                              : "bg-slate-500/10 text-slate-500"
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            o.status === 0 ? "bg-emerald-400" : o.status === 1 ? "bg-blue-400" : "bg-slate-500"
                          }`} />
                          {STATUS_LABELS[o.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-500">
                        {new Date(o.createdAt * 1000).toLocaleString()}
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        {o.status === 0 && account?.toLowerCase() !== o.maker.toLowerCase() ? (
                          <button
                            onClick={() => handleFill(o.id)}
                            disabled={filling === o.id}
                            className="bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 hover:border-blue-500/50 disabled:opacity-50 text-blue-400 text-xs font-medium px-4 py-1.5 rounded-lg transition-all duration-200 cursor-pointer hover:shadow-[0_0_12px_rgba(59,130,246,0.2)]"
                          >
                            {filling === o.id ? (
                              <span className="flex items-center gap-1.5">
                                <span className="w-3 h-3 border-2 border-blue-400/30 border-t-blue-400 rounded-full spinner" />
                                Filling...
                              </span>
                            ) : "Fill Order"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {filteredOrders.map((o, idx) => (
              <div
                key={o.id}
                className="bg-[#111827] border border-[#1e293b] rounded-xl p-4 row-enter"
                style={{ animationDelay: `${idx * 50}ms` }}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-500">#{o.id}</span>
                    <span className="font-semibold text-sm">{o.tokenPair}</span>
                    <span className={`text-xs font-bold ${o.isBuy ? "text-emerald-400" : "text-red-400"}`}>
                      {o.isBuy ? "BUY" : "SELL"}
                    </span>
                  </div>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                    o.status === 0
                      ? "bg-emerald-500/10 text-emerald-400 status-open"
                      : o.status === 1
                        ? "bg-blue-500/10 text-blue-400"
                        : "bg-slate-500/10 text-slate-500"
                  }`}>
                    {STATUS_LABELS[o.status]}
                  </span>
                </div>
                <div className="flex gap-2 mb-3">
                  <span className="encrypted-badge inline-flex items-center gap-1 border border-blue-500/20 rounded px-2 py-0.5 text-[10px] text-blue-300/80">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                    Price Encrypted
                  </span>
                  <span className="encrypted-badge inline-flex items-center gap-1 border border-blue-500/20 rounded px-2 py-0.5 text-[10px] text-blue-300/80">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                    Amount Encrypted
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span className="font-mono">{o.maker.slice(0, 6)}...{o.maker.slice(-4)}</span>
                  <span>{new Date(o.createdAt * 1000).toLocaleDateString()}</span>
                </div>
                {o.status === 0 && account?.toLowerCase() !== o.maker.toLowerCase() && (
                  <button
                    onClick={() => handleFill(o.id)}
                    disabled={filling === o.id}
                    className="mt-3 w-full bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/25 text-blue-400 text-xs font-medium py-2 rounded-lg transition-all cursor-pointer"
                  >
                    {filling === o.id ? "Filling..." : "Fill Order"}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Results count */}
          <div className="mt-4 text-xs text-slate-600 text-center">
            Showing {filteredOrders.length} of {orders.length} orders
          </div>
        </>
      )}
    </div>
  );
}
