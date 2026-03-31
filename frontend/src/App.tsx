import { Outlet, NavLink, useLocation } from "react-router-dom";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export function useWallet() {
  const { address } = useAccount();
  return {
    account: address ?? "",
    connect: async () => {
      // RainbowKit handles connection via ConnectButton
    },
  };
}

export default function App() {
  const location = useLocation();

  return (
    <>
      {/* Navigation */}
      <nav className="sticky top-0 z-50 border-b border-[#1e293b] bg-[#0a0e17]/90 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">
            {/* Logo + Nav Links */}
            <div className="flex items-center gap-6 sm:gap-8">
              <NavLink to="/" className="flex items-center gap-2.5 group">
                {/* Shield Logo */}
                <div className="relative shield-pulse">
                  <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                    <path d="M16 2L4 8v8c0 7.18 5.12 13.9 12 16 6.88-2.1 12-8.82 12-16V8L16 2z" fill="url(#shield-grad)" fillOpacity="0.15" stroke="url(#shield-grad)" strokeWidth="1.5"/>
                    <path d="M12 16l3 3 5-6" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    <defs>
                      <linearGradient id="shield-grad" x1="4" y1="2" x2="28" y2="26">
                        <stop stopColor="#3b82f6"/>
                        <stop offset="1" stopColor="#22c55e"/>
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
                <span className="text-xl font-bold tracking-tight">
                  <span className="text-blue-400">Shadow</span><span className="text-slate-100">OTC</span>
                </span>
              </NavLink>

              <div className="hidden sm:flex gap-1">
                {[
                  { to: "/", label: "Order Book", end: true },
                  { to: "/create", label: "Create Order" },
                  { to: "/vault", label: "Vault" },
                  { to: "/trades", label: "My Trades" },
                ].map((link) => (
                  <NavLink
                    key={link.to}
                    to={link.to}
                    end={link.end}
                    className={({ isActive }) =>
                      `relative px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                        isActive
                          ? "bg-blue-500/15 text-blue-400 nav-glow"
                          : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                      }`
                    }
                  >
                    {link.label}
                  </NavLink>
                ))}
              </div>
            </div>

            {/* Right side: Network badge + Wallet */}
            <div className="flex items-center gap-3">
              <ConnectButton.Custom>
                {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
                  const connected = mounted && account && chain;
                  return (
                    <div {...(!mounted ? { "aria-hidden": true, style: { opacity: 0, pointerEvents: "none" as const, userSelect: "none" as const } } : {})}>
                      {(() => {
                        if (!connected) {
                          return (
                            <button
                              onClick={openConnectModal}
                              className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white px-5 py-2 rounded-full text-sm font-medium transition-all duration-200 shadow-[0_0_20px_rgba(59,130,246,0.3)] hover:shadow-[0_0_30px_rgba(59,130,246,0.4)] cursor-pointer"
                            >
                              Connect Wallet
                            </button>
                          );
                        }
                        if (chain.unsupported) {
                          return (
                            <button
                              onClick={openChainModal}
                              className="bg-red-500/20 border border-red-500/30 text-red-400 px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 cursor-pointer hover:bg-red-500/30"
                            >
                              Wrong Network
                            </button>
                          );
                        }
                        return (
                          <div className="flex items-center gap-3">
                            <div className="hidden md:flex items-center gap-2 text-xs text-slate-500 bg-[#111827] rounded-full px-3 py-1.5 border border-[#1e293b]">
                              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
                              <span>{chain.name}</span>
                            </div>
                            <button
                              onClick={openAccountModal}
                              className="flex items-center gap-2 bg-[#111827] border border-[#1e293b] rounded-full px-4 py-2 hover:border-blue-500/30 transition-colors duration-300 cursor-pointer"
                            >
                              <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
                              <span className="text-sm font-mono text-slate-300">{account.displayName}</span>
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  );
                }}
              </ConnectButton.Custom>
            </div>
          </div>

          {/* Mobile nav */}
          <div className="sm:hidden flex gap-1 pb-3 -mx-1 overflow-x-auto">
            {[
              { to: "/", label: "Order Book", end: true },
              { to: "/create", label: "Create" },
              { to: "/vault", label: "Vault" },
              { to: "/trades", label: "Trades" },
            ].map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                    isActive
                      ? "bg-blue-500/15 text-blue-400"
                      : "text-slate-500 hover:text-slate-300"
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main key={location.pathname} className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8 page-fade-in">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="border-t border-[#1e293b] bg-[#0a0e17]/80">
        <div className="max-w-7xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-slate-500 text-xs">
            <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
              <path d="M16 2L4 8v8c0 7.18 5.12 13.9 12 16 6.88-2.1 12-8.82 12-16V8L16 2z" fill="#3b82f6" fillOpacity="0.2" stroke="#3b82f6" strokeWidth="1.5"/>
            </svg>
            ShadowOTC - Confidential OTC Trading
          </div>
          <div className="text-slate-600 text-xs">
            Powered by <span className="text-blue-400/70">Zama FHE</span> on Ethereum Sepolia
          </div>
        </div>
      </footer>
    </>
  );
}
