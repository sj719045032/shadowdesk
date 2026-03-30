import { useState, useEffect, useCallback } from "react";
import {
  getProvider,
  getETHBalance,
  getUSDCBalance,
  getCWETH,
  getCUSDC,
  CWETH_ADDRESS,
  CUSDC_ADDRESS,
  getUSDC,
  parseUnits,
} from "../lib/contract";
import { decryptValues } from "../lib/fhevm";
import { useWallet } from "../App";
import TransactionModal, { type Step } from "../components/TransactionModal";

// ---------------------------------------------------------------------------
// Vault Card Component
// ---------------------------------------------------------------------------

type VaultCardProps = {
  title: string;
  symbol: string;
  contractAddress: string;
  plaintextBalance: string;
  plaintextLoading: boolean;
  encryptedHandle: string | null;
  decryptedBalance: string | null;
  decryptLoading: boolean;
  onDecrypt: () => void;
  onWrap: (amount: string) => void;
  onUnwrap: (amount: string) => void;
  busy: boolean;
  account: string;
};

function VaultCard({
  title,
  symbol,
  contractAddress,
  plaintextBalance,
  plaintextLoading,
  encryptedHandle,
  decryptedBalance,
  decryptLoading,
  onDecrypt,
  onWrap,
  onUnwrap,
  busy,
  account,
}: VaultCardProps) {
  const [amount, setAmount] = useState("");
  const deployed = !!contractAddress;

  return (
    <div className="bg-[#111827] border border-[#1e293b] rounded-2xl overflow-hidden gradient-border card-glow">
      {/* Card Header */}
      <div className="px-5 sm:px-6 pt-5 sm:pt-6 pb-4 border-b border-[#1e293b]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
            {symbol === "ETH" ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M12 1.5l-8 12 8 4.5 8-4.5-8-12z" fill="#627eea" fillOpacity="0.3" stroke="#627eea" strokeWidth="1.2" />
                <path d="M4 13.5l8 4.5 8-4.5-8 9-8-9z" fill="#627eea" fillOpacity="0.15" stroke="#627eea" strokeWidth="1.2" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#2775ca" fillOpacity="0.2" stroke="#2775ca" strokeWidth="1.2" />
                <text x="12" y="16" textAnchor="middle" fill="#2775ca" fontSize="10" fontWeight="bold">$</text>
              </svg>
            )}
          </div>
          <div>
            <h3 className="text-base font-bold text-white">{title}</h3>
            <p className="text-xs text-slate-500">
              {symbol === "ETH" ? "Confidential Wrapped ETH" : "Confidential USDC"}
            </p>
          </div>
        </div>
      </div>

      {/* Balances */}
      <div className="px-5 sm:px-6 py-4 space-y-3">
        {/* Plaintext balance */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            {symbol} Balance
          </span>
          <span className="text-sm font-mono text-slate-200">
            {plaintextLoading ? (
              <span className="text-slate-500">Loading...</span>
            ) : (
              `${Number(plaintextBalance).toFixed(symbol === "ETH" ? 4 : 2)} ${symbol}`
            )}
          </span>
        </div>

        {/* Encrypted balance */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            c{symbol} Balance
          </span>
          {!deployed ? (
            <span className="text-xs text-slate-600">--</span>
          ) : decryptedBalance !== null ? (
            <span className="text-sm font-mono text-emerald-400 decrypt-reveal">
              {Number(decryptedBalance).toFixed(symbol === "ETH" ? 4 : 2)} c{symbol}
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="encrypted-badge inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-blue-400 border border-blue-500/20">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                Encrypted
              </span>
              {encryptedHandle && (
                <button
                  onClick={onDecrypt}
                  disabled={decryptLoading || !account}
                  className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors disabled:text-slate-600 disabled:no-underline cursor-pointer disabled:cursor-not-allowed"
                >
                  {decryptLoading ? "Decrypting..." : "Decrypt"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Not deployed banner */}
      {!deployed && (
        <div className="mx-5 sm:mx-6 mb-4 bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2.5">
          <svg className="flex-shrink-0 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-xs text-amber-400/80 leading-relaxed">
            Contract not deployed. The c{symbol} contract address has not been configured yet.
          </span>
        </div>
      )}

      {/* Input + Buttons */}
      <div className="px-5 sm:px-6 pb-5 sm:pb-6 space-y-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">
            Amount
          </label>
          <div className="relative">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              min="0"
              step="any"
              disabled={!deployed || busy}
              className="w-full bg-[#0d1117] border border-[#1e293b] rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500/50 focus:shadow-[0_0_12px_rgba(59,130,246,0.1)] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 font-medium">
              {symbol}
            </span>
          </div>
        </div>

        {/* Max button */}
        {deployed && plaintextBalance && Number(plaintextBalance) > 0 && (
          <button
            type="button"
            onClick={() => setAmount(plaintextBalance)}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
          >
            Max: {Number(plaintextBalance).toFixed(symbol === "ETH" ? 4 : 2)} {symbol}
          </button>
        )}

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => {
              if (amount && Number(amount) > 0) onWrap(amount);
            }}
            disabled={!deployed || busy || !amount || Number(amount) <= 0 || !account}
            className="py-3 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white shadow-[0_0_15px_rgba(34,197,94,0.15)] hover:shadow-[0_0_25px_rgba(34,197,94,0.25)] disabled:shadow-none disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500"
          >
            {busy ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full spinner" />
                ...
              </span>
            ) : (
              <span className="flex items-center justify-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                Wrap
              </span>
            )}
          </button>

          <button
            onClick={() => {
              if (amount && Number(amount) > 0) onUnwrap(amount);
            }}
            disabled={!deployed || busy || !amount || Number(amount) <= 0 || !account}
            className="py-3 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 bg-gradient-to-r from-orange-600 to-orange-500 hover:from-orange-500 hover:to-orange-400 text-white shadow-[0_0_15px_rgba(249,115,22,0.15)] hover:shadow-[0_0_25px_rgba(249,115,22,0.25)] disabled:shadow-none disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500"
          >
            {busy ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full spinner" />
                ...
              </span>
            ) : (
              <span className="flex items-center justify-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 5-5 5 5 0 0 1 5 5v1" />
                </svg>
                Unwrap
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vault Page
// ---------------------------------------------------------------------------

export default function Vault() {
  const { account, connect } = useWallet();

  // Plaintext balances
  const [ethBalance, setEthBalance] = useState("");
  const [usdcBalance, setUsdcBalance] = useState("");
  const [balancesLoading, setBalancesLoading] = useState(false);

  // Encrypted balance handles
  const [cwethHandle, setCwethHandle] = useState<string | null>(null);
  const [cusdcHandle, setCusdcHandle] = useState<string | null>(null);

  // Decrypted confidential balances
  const [cwethDecrypted, setCwethDecrypted] = useState<string | null>(null);
  const [cusdcDecrypted, setCusdcDecrypted] = useState<string | null>(null);
  const [cwethDecrypting, setCwethDecrypting] = useState(false);
  const [cusdcDecrypting, setCusdcDecrypting] = useState(false);

  // Transaction modal state
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [txTitle, setTxTitle] = useState("");
  const [txSteps, setTxSteps] = useState<Step[]>([]);
  const [txError, setTxError] = useState("");
  const [busy, setBusy] = useState(false);

  // ---- Load plaintext balances ----
  const loadBalances = useCallback(async () => {
    if (!account) return;
    setBalancesLoading(true);
    try {
      const [eth, usdc] = await Promise.all([
        getETHBalance(account),
        getUSDCBalance(account),
      ]);
      setEthBalance(eth);
      setUsdcBalance(usdc);
    } catch {
      // Silently fail - balances will show as 0
    } finally {
      setBalancesLoading(false);
    }
  }, [account]);

  // ---- Load encrypted balance handles ----
  const loadEncryptedHandles = useCallback(async () => {
    if (!account) return;
    try {
      if (CWETH_ADDRESS) {
        const cweth = await getCWETH();
        const handle = await cweth.balanceOf(account);
        if (handle && handle !== "0x" + "0".repeat(64)) {
          setCwethHandle(handle);
        }
      }
    } catch {
      // Contract may not be deployed yet
    }
    try {
      if (CUSDC_ADDRESS) {
        const cusdc = await getCUSDC();
        const handle = await cusdc.balanceOf(account);
        if (handle && handle !== "0x" + "0".repeat(64)) {
          setCusdcHandle(handle);
        }
      }
    } catch {
      // Contract may not be deployed yet
    }
  }, [account]);

  useEffect(() => {
    loadBalances();
    loadEncryptedHandles();
  }, [loadBalances, loadEncryptedHandles]);

  // ---- Decrypt helpers ----
  const handleDecryptCWETH = async () => {
    if (!account || !cwethHandle) return;
    setCwethDecrypting(true);
    try {
      const results = await decryptValues(
        [{ handle: cwethHandle, contractAddress: CWETH_ADDRESS }],
        account,
      );
      const val = results.get(cwethHandle);
      if (val !== undefined) {
        // cWETH uses 18 decimals like ETH
        const formatted = Number(val) / 1e18;
        setCwethDecrypted(formatted.toString());
      }
    } catch (err) {
      console.error("Failed to decrypt cWETH balance:", err);
    } finally {
      setCwethDecrypting(false);
    }
  };

  const handleDecryptCUSDC = async () => {
    if (!account || !cusdcHandle) return;
    setCusdcDecrypting(true);
    try {
      const results = await decryptValues(
        [{ handle: cusdcHandle, contractAddress: CUSDC_ADDRESS }],
        account,
      );
      const val = results.get(cusdcHandle);
      if (val !== undefined) {
        // cUSDC uses 6 decimals like USDC
        const formatted = Number(val) / 1e6;
        setCusdcDecrypted(formatted.toString());
      }
    } catch (err) {
      console.error("Failed to decrypt cUSDC balance:", err);
    } finally {
      setCusdcDecrypting(false);
    }
  };

  // ---- Step helpers ----
  function updateStep(idx: number, status: Step["status"]) {
    setTxSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, status } : s)),
    );
  }

  function markActiveAsError() {
    setTxSteps((prev) =>
      prev.map((s) => (s.status === "active" ? { ...s, status: "error" } : s)),
    );
  }

  // ---- Wrap ETH -> cWETH ----
  const handleWrapETH = async (amount: string) => {
    if (!account) {
      await connect();
      return;
    }
    const steps: Step[] = [
      { label: "Submitting wrap transaction", status: "pending" },
      { label: "Waiting for confirmation", status: "pending" },
    ];
    setTxTitle("Wrapping ETH -> cWETH");
    setTxSteps(steps);
    setTxError("");
    setTxModalOpen(true);
    setBusy(true);

    try {
      updateStep(0, "active");
      const cweth = await getCWETH(true);
      const tx = await cweth["wrap()"]({ value: parseUnits(amount, 18) });
      updateStep(0, "done");

      updateStep(1, "active");
      await tx.wait();
      updateStep(1, "done");

      // Refresh balances
      loadBalances();
      loadEncryptedHandles();
      setCwethDecrypted(null);
    } catch (err: unknown) {
      console.error(err);
      const msg = (err as Error).message?.slice(0, 120) || "Transaction failed";
      setTxError(msg);
      markActiveAsError();
    } finally {
      setBusy(false);
    }
  };

  // ---- Unwrap cWETH -> ETH ----
  const handleUnwrapETH = async (amount: string) => {
    if (!account) {
      await connect();
      return;
    }
    const steps: Step[] = [
      { label: "Submitting unwrap transaction", status: "pending" },
      { label: "Waiting for confirmation", status: "pending" },
    ];
    setTxTitle("Unwrapping cWETH -> ETH");
    setTxSteps(steps);
    setTxError("");
    setTxModalOpen(true);
    setBusy(true);

    try {
      updateStep(0, "active");
      const cweth = await getCWETH(true);
      const tx = await cweth.unwrap(parseUnits(amount, 18));
      updateStep(0, "done");

      updateStep(1, "active");
      await tx.wait();
      updateStep(1, "done");

      loadBalances();
      loadEncryptedHandles();
      setCwethDecrypted(null);
    } catch (err: unknown) {
      console.error(err);
      const msg = (err as Error).message?.slice(0, 120) || "Transaction failed";
      setTxError(msg);
      markActiveAsError();
    } finally {
      setBusy(false);
    }
  };

  // ---- Wrap USDC -> cUSDC ----
  const handleWrapUSDC = async (amount: string) => {
    if (!account) {
      await connect();
      return;
    }
    const steps: Step[] = [
      { label: "Approving USDC", status: "pending" },
      { label: "Submitting wrap transaction", status: "pending" },
      { label: "Waiting for confirmation", status: "pending" },
    ];
    setTxTitle("Wrapping USDC -> cUSDC");
    setTxSteps(steps);
    setTxError("");
    setTxModalOpen(true);
    setBusy(true);

    try {
      // Step 1: Approve USDC spending
      updateStep(0, "active");
      const usdc = await getUSDC(true);
      const needed = parseUnits(amount, 6);
      const signer = await getProvider().getSigner();
      const signerAddr = await signer.getAddress();
      const currentAllowance = await usdc.allowance(signerAddr, CUSDC_ADDRESS);
      if (currentAllowance < needed) {
        const approveTx = await usdc.approve(CUSDC_ADDRESS, needed);
        await approveTx.wait();
      }
      updateStep(0, "done");

      // Step 2: Wrap
      updateStep(1, "active");
      const cusdc = await getCUSDC(true);
      const tx = await cusdc["wrap(uint256)"](needed);
      updateStep(1, "done");

      // Step 3: Wait
      updateStep(2, "active");
      await tx.wait();
      updateStep(2, "done");

      loadBalances();
      loadEncryptedHandles();
      setCusdcDecrypted(null);
    } catch (err: unknown) {
      console.error(err);
      const msg = (err as Error).message?.slice(0, 120) || "Transaction failed";
      setTxError(msg);
      markActiveAsError();
    } finally {
      setBusy(false);
    }
  };

  // ---- Unwrap cUSDC -> USDC ----
  const handleUnwrapUSDC = async (amount: string) => {
    if (!account) {
      await connect();
      return;
    }
    const steps: Step[] = [
      { label: "Submitting unwrap transaction", status: "pending" },
      { label: "Waiting for confirmation", status: "pending" },
    ];
    setTxTitle("Unwrapping cUSDC -> USDC");
    setTxSteps(steps);
    setTxError("");
    setTxModalOpen(true);
    setBusy(true);

    try {
      updateStep(0, "active");
      const cusdc = await getCUSDC(true);
      const tx = await cusdc.unwrap(parseUnits(amount, 6));
      updateStep(0, "done");

      updateStep(1, "active");
      await tx.wait();
      updateStep(1, "done");

      loadBalances();
      loadEncryptedHandles();
      setCusdcDecrypted(null);
    } catch (err: unknown) {
      console.error(err);
      const msg = (err as Error).message?.slice(0, 120) || "Transaction failed";
      setTxError(msg);
      markActiveAsError();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto">
      {/* Hero Banner */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2.5 mb-3">
          <div className="relative shield-pulse">
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <path
                d="M16 2L4 8v8c0 7.18 5.12 13.9 12 16 6.88-2.1 12-8.82 12-16V8L16 2z"
                fill="url(#vault-grad)"
                fillOpacity="0.15"
                stroke="url(#vault-grad)"
                strokeWidth="1.5"
              />
              <rect x="11" y="13" width="10" height="8" rx="1.5" fill="none" stroke="#3b82f6" strokeWidth="1.5" />
              <path d="M14 13v-2a2 2 0 0 1 4 0v2" fill="none" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" />
              <defs>
                <linearGradient id="vault-grad" x1="4" y1="2" x2="28" y2="26">
                  <stop stopColor="#3b82f6" />
                  <stop offset="1" stopColor="#22c55e" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            <span className="text-blue-400">Confidential</span>{" "}
            <span className="text-slate-100">Vault</span>
          </h1>
        </div>
        <p className="text-sm text-slate-500 max-w-lg mx-auto">
          Wrap your assets into encrypted tokens (ERC-7984). Confidential balances are protected by fully homomorphic encryption.
        </p>
      </div>

      {/* Connect Wallet prompt */}
      {!account && (
        <div className="text-center py-12">
          <div className="inline-flex flex-col items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="14" rx="2" />
                <path d="M2 10h20" />
                <path d="M6 14h.01" />
              </svg>
            </div>
            <p className="text-slate-400 text-sm">Connect your wallet to manage confidential tokens</p>
            <button
              onClick={connect}
              className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white px-6 py-2.5 rounded-full text-sm font-medium transition-all duration-200 shadow-[0_0_20px_rgba(59,130,246,0.3)] hover:shadow-[0_0_30px_rgba(59,130,246,0.4)] cursor-pointer"
            >
              Connect Wallet
            </button>
          </div>
        </div>
      )}

      {/* Cards Grid */}
      {account && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* ETH <-> cWETH */}
          <VaultCard
            title="ETH <-> cWETH"
            symbol="ETH"

            contractAddress={CWETH_ADDRESS}
            plaintextBalance={ethBalance}
            plaintextLoading={balancesLoading}
            encryptedHandle={cwethHandle}
            decryptedBalance={cwethDecrypted}
            decryptLoading={cwethDecrypting}
            onDecrypt={handleDecryptCWETH}
            onWrap={handleWrapETH}
            onUnwrap={handleUnwrapETH}
            busy={busy}
            account={account}
          />

          {/* USDC <-> cUSDC */}
          <VaultCard
            title="USDC <-> cUSDC"
            symbol="USDC"

            contractAddress={CUSDC_ADDRESS}
            plaintextBalance={usdcBalance}
            plaintextLoading={balancesLoading}
            encryptedHandle={cusdcHandle}
            decryptedBalance={cusdcDecrypted}
            decryptLoading={cusdcDecrypting}
            onDecrypt={handleDecryptCUSDC}
            onWrap={handleWrapUSDC}
            onUnwrap={handleUnwrapUSDC}
            busy={busy}
            account={account}
          />
        </div>
      )}

      {/* Privacy info */}
      {account && (
        <div className="mt-8 flex items-start gap-2.5 bg-blue-500/5 border border-blue-500/10 rounded-xl p-4 max-w-2xl mx-auto">
          <svg className="mt-0.5 flex-shrink-0" width="16" height="16" viewBox="0 0 32 32" fill="none">
            <path d="M16 2L4 8v8c0 7.18 5.12 13.9 12 16 6.88-2.1 12-8.82 12-16V8L16 2z" fill="#3b82f6" fillOpacity="0.2" stroke="#3b82f6" strokeWidth="1.5" />
            <path d="M12 16l3 3 5-6" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-xs text-blue-300/70 leading-relaxed">
            Wrapped confidential tokens use Fully Homomorphic Encryption (FHE) to keep your balances private on-chain. Only you can decrypt and view your balance. Wrap and unwrap operations convert between standard tokens and their confidential counterparts at a 1:1 ratio.
          </span>
        </div>
      )}

      {/* Transaction Modal */}
      <TransactionModal
        open={txModalOpen}
        title={txTitle}
        steps={txSteps}
        error={txError}
        onClose={() => {
          setTxModalOpen(false);
          setTxError("");
        }}
      />
    </div>
  );
}
