import { useState, useEffect, createContext, useContext } from "react";
import { Outlet, NavLink } from "react-router-dom";
import { connectWallet, switchToSepolia } from "./lib/contract";

type WalletCtx = {
  account: string;
  connect: () => Promise<void>;
};

const WalletContext = createContext<WalletCtx>({
  account: "",
  connect: async () => {},
});

export function useWallet() {
  return useContext(WalletContext);
}

export default function App() {
  const [account, setAccount] = useState("");

  const connect = async () => {
    await switchToSepolia();
    const addr = await connectWallet();
    setAccount(addr);
  };

  useEffect(() => {
    if (window.ethereum) {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((result) => {
          const accounts = result as string[];
          if (accounts.length > 0) setAccount(accounts[0]);
        });
      window.ethereum.on("accountsChanged", (...args: unknown[]) => {
        const accounts = args[0] as string[];
        setAccount(accounts[0] || "");
      });
    }
  }, []);

  const short = account
    ? `${account.slice(0, 6)}...${account.slice(-4)}`
    : "";

  return (
    <WalletContext.Provider value={{ account, connect }}>
      <nav className="flex items-center justify-between px-6 py-4 border-b border-[#2a3a52] bg-[#111827]/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="flex items-center gap-8">
          <NavLink to="/" className="text-xl font-bold text-white tracking-tight">
            <span className="text-blue-400">Shadow</span>Desk
          </NavLink>
          <div className="flex gap-1">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `px-4 py-2 rounded-lg text-sm font-medium transition ${isActive ? "bg-blue-500/20 text-blue-400" : "text-slate-400 hover:text-white hover:bg-white/5"}`
              }
            >
              Order Book
            </NavLink>
            <NavLink
              to="/create"
              className={({ isActive }) =>
                `px-4 py-2 rounded-lg text-sm font-medium transition ${isActive ? "bg-blue-500/20 text-blue-400" : "text-slate-400 hover:text-white hover:bg-white/5"}`
              }
            >
              Create Order
            </NavLink>
            <NavLink
              to="/trades"
              className={({ isActive }) =>
                `px-4 py-2 rounded-lg text-sm font-medium transition ${isActive ? "bg-blue-500/20 text-blue-400" : "text-slate-400 hover:text-white hover:bg-white/5"}`
              }
            >
              My Trades
            </NavLink>
          </div>
        </div>
        {account ? (
          <div className="flex items-center gap-2 bg-[#1a2235] border border-[#2a3a52] rounded-lg px-4 py-2">
            <div className="w-2 h-2 rounded-full bg-green-400" />
            <span className="text-sm font-mono text-slate-300">{short}</span>
          </div>
        ) : (
          <button
            onClick={connect}
            className="bg-blue-500 hover:bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium transition cursor-pointer"
          >
            Connect Wallet
          </button>
        )}
      </nav>
      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8">
        <Outlet />
      </main>
      <footer className="text-center text-slate-500 text-xs py-6 border-t border-[#2a3a52]">
        ShadowDesk - Confidential OTC Trading powered by Zama FHE
      </footer>
    </WalletContext.Provider>
  );
}
