import { useState, useEffect } from "react";
import { fetchAllOrders, type OrderData, getContract } from "../lib/contract";
import { useWallet } from "../App";

const STATUS_LABELS = ["Open", "Filled", "Cancelled"];
const STATUS_COLORS = [
  "bg-green-500/20 text-green-400",
  "bg-blue-500/20 text-blue-400",
  "bg-slate-500/20 text-slate-400",
];

export default function OrderBook() {
  const { account, connect } = useWallet();
  const [orders, setOrders] = useState<OrderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filling, setFilling] = useState<number | null>(null);

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
      const contract = await getContract(true);
      const tx = await contract.fillOrder(orderId);
      await tx.wait();
      await loadOrders();
    } catch (err) {
      console.error("Fill failed:", err);
    } finally {
      setFilling(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Order Book</h1>
          <p className="text-slate-400 text-sm mt-1">
            Prices and amounts are encrypted. Only counterparties can view details.
          </p>
        </div>
        <button
          onClick={loadOrders}
          className="text-sm text-slate-400 hover:text-white border border-[#2a3a52] rounded-lg px-4 py-2 transition cursor-pointer"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-center py-20 text-slate-400">Loading orders...</div>
      ) : orders.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-4xl mb-4">🔒</div>
          <div className="text-slate-400">No orders yet. Be the first to create one.</div>
        </div>
      ) : (
        <div className="border border-[#2a3a52] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-[#111827] text-slate-400 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">ID</th>
                <th className="text-left px-4 py-3">Pair</th>
                <th className="text-left px-4 py-3">Side</th>
                <th className="text-left px-4 py-3">Price</th>
                <th className="text-left px-4 py-3">Amount</th>
                <th className="text-left px-4 py-3">Maker</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Time</th>
                <th className="text-right px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-[#2a3a52] hover:bg-[#1a2235]/50 transition">
                  <td className="px-4 py-3 font-mono text-sm">#{o.id}</td>
                  <td className="px-4 py-3 font-medium">{o.tokenPair}</td>
                  <td className="px-4 py-3">
                    <span className={`text-sm font-medium ${o.isBuy ? "text-green-400" : "text-red-400"}`}>
                      {o.isBuy ? "BUY" : "SELL"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="bg-[#1a2235] border border-[#2a3a52] rounded px-2 py-0.5 text-xs text-slate-400">
                      🔒 Encrypted
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="bg-[#1a2235] border border-[#2a3a52] rounded px-2 py-0.5 text-xs text-slate-400">
                      🔒 Encrypted
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {o.maker.slice(0, 6)}...{o.maker.slice(-4)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[o.status]}`}>
                      {STATUS_LABELS[o.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {new Date(o.createdAt * 1000).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {o.status === 0 &&
                    account?.toLowerCase() !== o.maker.toLowerCase() ? (
                      <button
                        onClick={() => handleFill(o.id)}
                        disabled={filling === o.id}
                        className="bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg transition cursor-pointer"
                      >
                        {filling === o.id ? "Filling..." : "Fill"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
