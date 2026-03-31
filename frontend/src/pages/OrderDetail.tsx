import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { CONTRACT_ADDRESS, CWETH_ADDRESS, CUSDC_ADDRESS, ZERO_FHE_HANDLE, needsOperatorSetup, ensureOperatorSet, parseUnits, formatUnits, fetchOrderFillIds, fetchFillDetail, getAccessRequests, getGrantedAddresses, getAccessStatus, otcRead, otcWrite, waitTx, cwethRead, cusdcRead, getPendingFillsForOrder, parseFillInitiatedId, parseFillCancelledReason, type FillData, type PendingFillInfo } from "../lib/contract";
import { useWallet } from "../App";
import { encryptInputs, publicDecryptFillHandles, decryptValues, unscaleFromFHE } from "../lib/fhevm";
import TransactionModal, { type Step } from "../components/TransactionModal";

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { account, connect } = useWallet();
  const orderId = Number(id);

  const [order, setOrder] = useState<{
    tokenPair: string; isBuy: boolean; status: number;
    createdAt: number; baseDeposit: string; quoteDeposit: string;
    baseRemaining: string; quoteRemaining: string;
  } | null>(null);
  const [isMaker, setIsMaker] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState("");
  const [fillAmount, setFillAmount] = useState("");
  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState("");
  const [takerBalance, setTakerBalance] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [fills, setFills] = useState<FillData[]>([]);
  const [fillsLoading, setFillsLoading] = useState(true);

  // Pending fill recovery state
  const [pendingFills, setPendingFills] = useState<PendingFillInfo[]>([]);
  const [resuming, setResuming] = useState(false);

  // Access management state
  const [accessRequests, setAccessRequests] = useState<string[]>([]);
  const [grantedAddresses, setGrantedAddresses] = useState<string[]>([]);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessRequested, setAccessRequested] = useState(false);
  const [accessGranted, setAccessGranted] = useState(false);

  // Transaction modal state
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [txModalTitle, setTxModalTitle] = useState("");
  const [txSteps, setTxSteps] = useState<Step[]>([]);
  const [txError, setTxError] = useState("");

  function openTxModal(title: string, steps: Step[]) {
    setTxModalTitle(title);
    setTxSteps(steps);
    setTxError("");
    setTxModalOpen(true);
  }

  function updateTxStep(idx: number, status: Step["status"]) {
    setTxSteps((prev) => prev.map((s, i) => i === idx ? { ...s, status } : s));
  }

  function failTxModal(msg: string) {
    setTxError(msg);
    setTxSteps((prev) => prev.map((s) => s.status === "active" ? { ...s, status: "error" } : s));
  }

  useEffect(() => { loadOrder(); loadFills(); loadAccessData(); loadPendingFills(); }, [orderId, account]);

  async function loadPendingFills() {
    if (!account) { setPendingFills([]); return; }
    try {
      const pending = await getPendingFillsForOrder(orderId);
      setPendingFills(pending);
    } catch {
      // non-critical
    }
  }

  async function loadAccessData() {
    try {
      setAccessLoading(true);

      if (!account) {
        setIsMaker(false);
        setAccessRequests([]);
        setGrantedAddresses([]);
        setAccessRequested(false);
        setAccessGranted(false);
        return;
      }

      const status = await getAccessStatus(orderId);
      setIsMaker(status.isMaker);
      setAccessRequested(status.hasRequested);
      setAccessGranted(status.hasAccess);

      if (status.isMaker) {
        const [requests, granted] = await Promise.all([
          getAccessRequests(orderId),
          getGrantedAddresses(orderId),
        ]);
        setAccessRequests(requests);
        setGrantedAddresses(granted);
      } else {
        setAccessRequests([]);
        setGrantedAddresses([]);
      }
    } catch {
      setAccessRequests([]);
      setGrantedAddresses([]);
      setAccessRequested(false);
      setAccessGranted(false);
      setIsMaker(false);
    } finally {
      setAccessLoading(false);
    }
  }

  async function loadOrder() {
    try {
      setLoading(true);
      const o = await otcRead<readonly unknown[]>("getOrder", [orderId]);
      setOrder({
        tokenPair: o[0] as string, isBuy: o[1] as boolean, status: Number(o[2]),
        createdAt: Number(o[3]),
        baseDeposit: formatUnits((o[4] as bigint) ?? 0n, 18),
        quoteDeposit: formatUnits((o[5] as bigint) ?? 0n, 6),
        baseRemaining: formatUnits((o[6] as bigint) ?? 0n, 18),
        quoteRemaining: formatUnits((o[7] as bigint) ?? 0n, 6),
      });
    } catch {
      setOrder(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadFills() {
    try {
      setFillsLoading(true);
      const ids = await fetchOrderFillIds(orderId);
      const details = await Promise.all(ids.map((id) => fetchFillDetail(id)));
      setFills(details);
    } catch {
      setFills([]);
    } finally {
      setFillsLoading(false);
    }
  }

  async function handleDecrypt() {
    if (!account) { await connect(); return; }
    try {
      setDecrypting(true); setDecryptError("");

      // Read all handles in parallel, then decrypt in one signing request
      const isSellOrder = !order!.isBuy;
      const readFn = isSellOrder ? cusdcRead : cwethRead;
      const tokenAddr = isSellOrder ? CUSDC_ADDRESS : CWETH_ADDRESS;

      const [encPrice, encAmount, balanceHandle] = await Promise.all([
        otcRead<string>("getPrice", [orderId]),
        otcRead<string>("getAmount", [orderId]),
        readFn<string>("confidentialBalanceOf", [account]).then(String).catch(() => ZERO_FHE_HANDLE),
      ]);

      // Build handles array — order terms + optional balance
      const handles: { handle: string; contractAddress: string }[] = [
        { handle: encPrice.toString(), contractAddress: CONTRACT_ADDRESS },
        { handle: encAmount.toString(), contractAddress: CONTRACT_ADDRESS },
      ];
      const hasBalance = balanceHandle && balanceHandle !== ZERO_FHE_HANDLE;
      if (hasBalance) {
        handles.push({ handle: balanceHandle, contractAddress: tokenAddr });
      }

      // Single decryptValues call = single wallet signature
      const results = await decryptValues(handles, account);
      const values = [...results.values()];

      const p = unscaleFromFHE(Number(values[0] || 0n));
      const a = unscaleFromFHE(Number(values[1] || 0n));
      setDecryptedPrice(p);
      setDecryptedAmount(a);

      if (hasBalance && values[2] !== undefined) {
        setTakerBalance(String(Number(values[2]) / 1e6));
      } else {
        setTakerBalance("0");
      }

      const remaining = order!.isBuy ? Number(order!.quoteRemaining) / p : Number(order!.baseRemaining);
      setFillAmount(String(remaining));
    } catch (err) {
      const msg = (err as Error).message || "";
      if (msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("denied") || msg.toLowerCase().includes("cancel")) {
        setDecryptError("Signature rejected by user.");
      } else {
        setDecryptError("Access denied. Ask the maker to grant you access first.");
      }
    } finally {
      setDecrypting(false);
    }
  }

  async function handleResumeFill(pf: PendingFillInfo) {
    const steps: Step[] = [
      { label: "Decrypting match result", status: "pending" },
      { label: "Settling fill", status: "pending" },
      { label: "Waiting for confirmation", status: "pending" },
    ];
    openTxModal("Resuming Fill", steps);
    setResuming(true);

    try {
      // Step 1: Decrypt
      updateTxStep(0, "active");
      const handles = await otcRead<readonly [`0x${string}`, `0x${string}`]>(
        "getPendingFillHandles", [pf.pendingFillId],
      );
      const decryptResult = await publicDecryptFillHandles(handles[0], handles[1]);
      updateTxStep(0, "done");

      // Step 2: Settle
      updateTxStep(1, "active");
      const hash = await otcWrite("settleFill", [
        pf.pendingFillId,
        decryptResult.priceMatched,
        decryptResult.fillAmount,
        decryptResult.handlesList,
        decryptResult.cleartexts,
        decryptResult.decryptionProof,
      ]);
      updateTxStep(1, "done");

      // Step 3: Wait for confirmation
      updateTxStep(2, "active");
      const receipt = await waitTx(hash);

      const cancelReason = parseFillCancelledReason(receipt.logs);
      if (cancelReason) throw new Error(cancelReason);
      updateTxStep(2, "done");

      await Promise.all([loadOrder(), loadFills(), loadPendingFills()]);
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 120) || "Resume failed";
      setFillError(msg);
      failTxModal(msg);
    } finally {
      setResuming(false);
    }
  }

  async function handleFill() {
    if (!account || !decryptedPrice || !fillAmount) return;
    const fillAmt = Number(fillAmount);
    const price = decryptedPrice;
    setFillError("");

    // Pre-flight balance check: taker must have confidential tokens
    const isSellOrder = !order!.isBuy;
    const payToken = isSellOrder ? "cUSDC" : "cWETH";
    const readFn = isSellOrder ? cusdcRead : cwethRead;
    try {
      const handle = String(await readFn<string>("confidentialBalanceOf", [account]));
      if (!handle || handle === ZERO_FHE_HANDLE) {
        setFillError(`No ${payToken} balance. Wrap tokens in Vault first.`);
        return;
      }
    } catch {
      // non-blocking: skip check if read fails
    }

    // Authorization gate — separate from business flow
    if (await needsOperatorSetup()) {
      openTxModal("Authorization", [{ label: "Setting up OTC authorization", status: "active" }]);
      try {
        await ensureOperatorSet();
        setTxModalOpen(false);
      } catch (err) {
        failTxModal((err as Error).message?.slice(0, 100) || "Authorization failed");
        return;
      }
    }

    const steps: Step[] = [
      { label: "Encrypting bid", status: "pending" },
      { label: "Submitting fill", status: "pending" },
      { label: "Decrypting result", status: "pending" },
      { label: "Settling", status: "pending" },
    ];
    openTxModal("Filling Order", steps);

    try {
      setFilling(true); setFillError("");

      // Step 1: Encrypting bid
      updateTxStep(0, "active");
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 100)));
      const encrypted = await encryptInputs(account, price, fillAmt);
      updateTxStep(0, "done");

      const ethAmt = String(fillAmt);
      const usdcAmt = String(fillAmt * price);

      // Step 2: Submitting fill (initiateFill + confirmation)
      updateTxStep(1, "active");
      const hash1 = await otcWrite("initiateFill", [
        orderId,
        encrypted.handles[0], encrypted.inputProof,
        encrypted.handles[1], encrypted.inputProof,
        parseUnits(ethAmt, 18),
        parseUnits(usdcAmt, 6),
      ]);
      const receipt = await waitTx(hash1);
      const pendingFillId = parseFillInitiatedId(receipt.logs);
      updateTxStep(1, "done");

      // Step 3: Decrypting result via Gateway
      updateTxStep(2, "active");
      const handles = await otcRead<readonly [`0x${string}`, `0x${string}`]>(
        "getPendingFillHandles", [pendingFillId],
      );
      const decryptResult = await publicDecryptFillHandles(handles[0], handles[1]);
      updateTxStep(2, "done");

      // Step 4: Settling (settleFill + confirmation)
      updateTxStep(3, "active");
      const hash2 = await otcWrite("settleFill", [
        pendingFillId,
        decryptResult.priceMatched,
        decryptResult.fillAmount,
        decryptResult.handlesList,
        decryptResult.cleartexts,
        decryptResult.decryptionProof,
      ]);
      const receipt2 = await waitTx(hash2);

      const fillCancelReason = parseFillCancelledReason(receipt2.logs);
      if (fillCancelReason) {
        throw new Error(fillCancelReason);
      }

      updateTxStep(3, "done");

      await Promise.all([loadOrder(), loadFills(), loadPendingFills()]);
      // Reset decrypt state so remaining recalculates on next decrypt
      setDecryptedPrice(null);
      setDecryptedAmount(null);
      setFillAmount("");
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 100) || "Transaction failed";
      setFillError(msg);
      failTxModal(msg);
    } finally {
      setFilling(false);
    }
  }

  async function handleGrantAccess() {
    const addr = window.prompt("Enter taker address:");
    if (!addr?.startsWith("0x") || addr.length !== 42) return;

    const steps: Step[] = [
      { label: "Submitting grant access", status: "pending" },
      { label: "Waiting for confirmation", status: "pending" },
    ];
    openTxModal("Granting Access", steps);

    try {
      updateTxStep(0, "active");
      const hash = await otcWrite("grantAccess", [orderId, addr]);
      updateTxStep(0, "done");

      updateTxStep(1, "active");
      await waitTx(hash);
      updateTxStep(1, "done");
      await loadAccessData();
    } catch (err) {
      failTxModal((err as Error).message?.slice(0, 100) || "Transaction failed");
    }
  }

  async function handleCancelOrder() {
    if (!confirm("Are you sure you want to cancel this order? Your escrowed tokens will be refunded.")) return;
    const steps: Step[] = [
      { label: "Cancelling order", status: "pending" },
      { label: "Waiting for confirmation", status: "pending" },
    ];
    openTxModal("Cancel Order", steps);
    try {
      updateTxStep(0, "active");
      const hash = await otcWrite("cancelOrder", [orderId]);
      updateTxStep(0, "done");

      updateTxStep(1, "active");
      await waitTx(hash);
      updateTxStep(1, "done");

      await loadOrder();
    } catch (err) {
      failTxModal((err as Error).message?.slice(0, 100) || "Cancel failed");
    }
  }

  async function handleRequestAccess() {
    if (!account) { await connect(); return; }
    const steps: Step[] = [
      { label: "Submitting access request", status: "pending" },
      { label: "Waiting for confirmation", status: "pending" },
    ];
    openTxModal("Requesting Access", steps);
    try {
      updateTxStep(0, "active");
      const hash = await otcWrite("requestAccess", [orderId]);
      updateTxStep(0, "done");
      updateTxStep(1, "active");
      await waitTx(hash);
      updateTxStep(1, "done");
      setAccessRequested(true);
      setAccessGranted(false);
      await loadAccessData();
    } catch (err) {
      failTxModal((err as Error).message?.slice(0, 100) || "Transaction failed");
    }
  }

  async function handleApproveAccess(addr: string) {
    const steps: Step[] = [
      { label: "Submitting grant access", status: "pending" },
      { label: "Waiting for confirmation", status: "pending" },
    ];
    openTxModal("Granting Access", steps);
    try {
      updateTxStep(0, "active");
      const hash = await otcWrite("grantAccess", [orderId, addr]);
      updateTxStep(0, "done");
      updateTxStep(1, "active");
      await waitTx(hash);
      updateTxStep(1, "done");
      await loadAccessData();
    } catch (err) {
      failTxModal((err as Error).message?.slice(0, 100) || "Transaction failed");
    }
  }

  if (loading) return <div className="flex items-center justify-center py-20"><div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full spinner" /></div>;
  if (!order) return <div className="text-center py-20 text-slate-400">Order #{orderId} not found</div>;

  const usdcToPay = decryptedPrice && fillAmount ? (Number(fillAmount) * decryptedPrice).toLocaleString() : "—";

  return (
    <div className="max-w-2xl mx-auto">
      {/* Back button */}
      <button onClick={() => navigate("/")} className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-blue-400 mb-6 transition cursor-pointer">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        Back to Order Book
      </button>

      {/* Header */}
      <div className="bg-[#111827] border border-[#1e293b] rounded-2xl overflow-hidden gradient-border card-glow mb-6">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-white">Order #{orderId}</span>
              <span className={`text-xs font-bold px-2.5 py-1 rounded ${order.isBuy ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                {order.isBuy ? "BUY" : "SELL"}
              </span>
              <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full ${
                order.status === 0 ? "bg-emerald-500/10 text-emerald-400 status-open" : order.status === 1 ? "bg-blue-500/10 text-blue-400" : "bg-slate-500/10 text-slate-500"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${order.status === 0 ? "bg-emerald-400" : order.status === 1 ? "bg-blue-400" : "bg-slate-500"}`} />
                {["Open", "Filled", "Cancelled"][order.status]}
              </span>
            </div>
            <span className="text-lg font-medium text-slate-300">{order.tokenPair}</span>
          </div>

          {/* Maker info */}
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{new Date(order.createdAt * 1000).toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Price & Amount section */}
      <div className="bg-[#111827] border border-[#1e293b] rounded-2xl overflow-hidden gradient-border mb-6">
        <div className="p-6">
          <h3 className="text-sm font-semibold text-slate-300 mb-4">Encrypted Terms</h3>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-[#0d1117] rounded-xl p-4 border border-[#1e293b]/50">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Price</div>
              {decryptedPrice !== null ? (
                <div className="text-xl font-bold text-emerald-400 decrypt-reveal">${decryptedPrice.toLocaleString()}</div>
              ) : (
                <div className="encrypted-badge inline-flex items-center gap-1.5 border border-blue-500/20 rounded px-2.5 py-1 text-xs text-blue-300/80">🔒 Encrypted</div>
              )}
            </div>
            <div className="bg-[#0d1117] rounded-xl p-4 border border-[#1e293b]/50">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Original Amount</div>
              {decryptedAmount !== null ? (
                <div className="text-xl font-bold text-emerald-400 decrypt-reveal">{decryptedAmount} {order.tokenPair.split("/")[0]}</div>
              ) : (
                <div className="encrypted-badge inline-flex items-center gap-1.5 border border-blue-500/20 rounded px-2.5 py-1 text-xs text-blue-300/80">🔒 Encrypted</div>
              )}
            </div>
            <div className="bg-[#0d1117] rounded-xl p-4 border border-[#1e293b]/50">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Remaining</div>
              {decryptedAmount !== null ? (
                <div className={`text-xl font-bold decrypt-reveal ${Number(fillAmount) < decryptedAmount ? "text-amber-400" : "text-emerald-400"}`}>
                  {fillAmount} {order.tokenPair.split("/")[0]}
                </div>
              ) : (
                <div className="encrypted-badge inline-flex items-center gap-1.5 border border-blue-500/20 rounded px-2.5 py-1 text-xs text-blue-300/80">🔒 Encrypted</div>
              )}
            </div>
          </div>

          {decryptedPrice === null && (isMaker || accessGranted) && (
            <>
              {decryptError && (
                <div className={`rounded-lg p-3 mb-3 text-sm ${
                  decryptError.includes("rejected")
                    ? "bg-amber-500/10 border border-amber-500/20 text-amber-400"
                    : "bg-red-500/10 border border-red-500/20 text-red-400"
                }`}>
                  {decryptError.includes("rejected") ? "⚠️" : "🚫"} {decryptError}
                </div>
              )}
              <button onClick={handleDecrypt} disabled={decrypting}
                className="w-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 text-blue-400 py-3 rounded-xl text-sm font-medium transition cursor-pointer disabled:opacity-50">
                {decrypting ? "Decrypting..." : "🔓 Decrypt Order Details"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Access Management — hide for granted non-makers (they can already decrypt/fill) */}
      {order.status === 0 && !(isMaker === false && accessGranted) && (
        <div className="bg-[#111827] border border-[#1e293b] rounded-2xl overflow-hidden gradient-border mb-4">
          <div className="px-5 py-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Access</h3>

            {accessLoading || isMaker === null ? (
              <div className="flex items-center justify-center py-6">
                <div className="w-5 h-5 border-2 border-purple-500/30 border-t-purple-500 rounded-full spinner" />
              </div>
            ) : isMaker ? (
              /* Maker view: show pending requests and granted addresses */
              <div className="space-y-5">
                {/* Pending Requests */}
                <div>
                  <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                    Pending Requests ({accessRequests.filter(
                      (addr) => !grantedAddresses.some((g) => g.toLowerCase() === addr.toLowerCase())
                    ).length})
                  </div>
                  {accessRequests.filter(
                    (addr) => !grantedAddresses.some((g) => g.toLowerCase() === addr.toLowerCase())
                  ).length === 0 ? (
                    <div className="text-sm text-slate-500 py-2">No pending requests</div>
                  ) : (
                    <div className="space-y-2">
                      {accessRequests
                        .filter((addr) => !grantedAddresses.some((g) => g.toLowerCase() === addr.toLowerCase()))
                        .map((addr) => (
                          <div key={addr} className="flex items-center justify-between bg-[#0d1117] rounded-xl px-4 py-3 border border-[#1e293b]/50">
                            <span className="text-sm text-slate-300 font-mono">
                              {addr.slice(0, 6)}...{addr.slice(-4)}
                            </span>
                            <button
                              onClick={() => handleApproveAccess(addr)}
                              className="bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 text-purple-400 px-4 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer"
                            >
                              Approve
                            </button>
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                {/* Granted Addresses */}
                <div>
                  <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                    Granted ({grantedAddresses.length})
                  </div>
                  {grantedAddresses.length === 0 ? (
                    <div className="text-sm text-slate-500 py-2">No granted addresses</div>
                  ) : (
                    <div className="space-y-2">
                      {grantedAddresses.map((addr) => (
                        <div key={addr} className="flex items-center justify-between bg-[#0d1117] rounded-xl px-4 py-3 border border-[#1e293b]/50">
                          <span className="text-sm text-slate-300 font-mono">
                            {addr.slice(0, 6)}...{addr.slice(-4)}
                          </span>
                          <span className="text-emerald-400 text-sm">{"\u2705"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* Taker view: request access button or requested state */
              <div>
                {accessGranted ? (
                  <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 text-sm text-emerald-400">
                    {"\u2713"} Access Granted
                  </div>
                ) : accessRequested ? (
                  <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 text-sm text-emerald-400">
                    {"\u2713"} Access Requested
                  </div>
                ) : (
                  <button
                    onClick={handleRequestAccess}
                    className="w-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 text-blue-400 py-3 rounded-xl text-sm font-medium transition cursor-pointer"
                  >
                    {"\uD83D\uDD13"} Request Access
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Fill History — compact, collapse when empty */}
      <div className="bg-[#111827] border border-[#1e293b] rounded-2xl overflow-hidden gradient-border mb-4">
        <div className="px-5 py-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Fills {!fillsLoading && fills.length > 0 && `(${fills.length})`}
          </h3>
          {fillsLoading ? (
            <div className="flex items-center justify-center py-3">
              <div className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full spinner" />
            </div>
          ) : fills.length === 0 ? (
            <div className="text-xs text-slate-600">No fills yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[11px] text-slate-500 uppercase tracking-wider">
                    <th className="text-left px-3 py-2 font-semibold">#</th>
                    <th className="text-left px-3 py-2 font-semibold">ETH</th>
                    <th className="text-left px-3 py-2 font-semibold">USDC</th>
                    <th className="text-left px-3 py-2 font-semibold">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.map((f, idx) => (
                    <tr key={idx} className="border-t border-[#1e293b]/60">
                      <td className="px-3 py-2.5 text-xs text-slate-500 font-mono">{idx}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-200">{f.ethTransferred}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-200">{f.tokenTransferred}</td>
                      <td className="px-3 py-2.5 text-xs text-slate-400">
                        {new Date(f.filledAt * 1000).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}{" "}
                        {new Date(f.filledAt * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Pending fill recovery */}
      {pendingFills.length > 0 && (
        <div className="bg-[#111827] border border-amber-500/20 rounded-2xl overflow-hidden mb-6">
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-amber-400">⚠️</span>
              <h3 className="text-sm font-semibold text-amber-300">Pending Fill — Needs Settlement</h3>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              A previous fill was initiated but not yet settled. Resume to complete the decryption and settlement.
            </p>
            <div className="space-y-3">
              {pendingFills.map((pf) => (
                <div key={pf.pendingFillId} className="flex items-center justify-between bg-[#0d1117] rounded-xl px-4 py-3 border border-[#1e293b]/50">
                  <div>
                    <div className="text-sm text-slate-300">Fill #{pf.pendingFillId}</div>
                    <div className="text-xs text-slate-500 font-mono">{pf.txHash.slice(0, 10)}...{pf.txHash.slice(-6)}</div>
                  </div>
                  <button
                    onClick={() => handleResumeFill(pf)}
                    disabled={resuming}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-400 transition cursor-pointer disabled:opacity-50"
                  >
                    {resuming ? "Resuming..." : "Resume Settlement"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Fill section - only for confirmed non-maker, open orders, after decrypt */}
      {isMaker === false && order.status === 0 && decryptedPrice !== null && (
        <div className="bg-[#111827] border border-[#1e293b] rounded-2xl overflow-hidden gradient-border mb-6">
          <div className="p-6">
            <h3 className="text-sm font-semibold text-slate-300 mb-4">Fill This Order</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5 uppercase tracking-wider">Fill Amount ({order.tokenPair.split("/")[0]})</label>
                <input type="number" value={fillAmount} onChange={(e) => setFillAmount(e.target.value)}
                  step="any" min="0.000001" max={decryptedAmount || undefined}
                  className="w-full bg-[#0d1117] border border-[#1e293b] rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500/50 transition" />
              </div>
              {Number(fillAmount) > 0 && (
                <div className="bg-[#0d1117] rounded-xl p-4 border border-[#1e293b]/50 space-y-2">
                  <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Settlement Preview</div>
                  {order.isBuy ? (
                    <>
                      <div className="flex justify-between text-sm"><span className="text-slate-400">You pay</span><span className="text-red-400 font-medium">{fillAmount} ETH</span></div>
                      <div className="flex justify-between text-sm"><span className="text-slate-400">You receive</span><span className="text-emerald-400 font-medium">{usdcToPay} USDC</span></div>
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between text-sm"><span className="text-slate-400">You pay</span><span className="text-red-400 font-medium">{usdcToPay} USDC</span></div>
                      <div className="flex justify-between text-sm"><span className="text-slate-400">You receive</span><span className="text-emerald-400 font-medium">{fillAmount} ETH</span></div>
                    </>
                  )}
                  {takerBalance !== null && (
                    <div className="flex justify-between text-sm border-t border-[#1e293b]/50 pt-2 mt-2">
                      <span className="text-slate-500">Your balance</span>
                      <span className={`font-medium ${Number(takerBalance) >= Number(order.isBuy ? fillAmount : usdcToPay) ? "text-emerald-400" : "text-red-400"}`}>
                        {Number(takerBalance).toLocaleString()} {order.isBuy ? "cWETH" : "cUSDC"}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {(() => {
                const requiredAmount = Number(order.isBuy ? fillAmount : usdcToPay);
                const bal = takerBalance !== null ? Number(takerBalance) : null;
                const insufficient = bal !== null && requiredAmount > 0 && bal < requiredAmount;
                const tokenName = order.isBuy ? "cWETH" : "cUSDC";
                return (<>
                  {fillError && <div className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg p-3">{fillError}</div>}
                  {insufficient && !fillError && (
                    <div className="text-amber-400 text-sm bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 flex items-center justify-between">
                      <span>Insufficient {tokenName} balance. Wrap more in Vault.</span>
                      <a href="/vault" className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2 ml-2 whitespace-nowrap">Go to Vault →</a>
                    </div>
                  )}
                  <button onClick={handleFill} disabled={filling || !fillAmount || Number(fillAmount) <= 0 || insufficient}
                    className={`w-full py-3.5 rounded-xl font-semibold transition cursor-pointer disabled:opacity-50 ${
                      order.isBuy ? "bg-gradient-to-r from-red-600 to-red-500 text-white" : "bg-gradient-to-r from-emerald-600 to-emerald-500 text-white"
                    }`}>
                    {filling ? "Filling..." : "Fill Order"}
                  </button>
                </>);
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Maker actions */}
      {isMaker && order.status === 0 && (
        <div className="flex gap-3">
          <button onClick={handleGrantAccess}
            className="flex-1 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 text-purple-400 py-3 rounded-xl text-sm font-medium transition cursor-pointer">
            Grant Access
          </button>
          <button onClick={() => { const url = window.location.href; navigator.clipboard.writeText(url); setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000); }}
            className="flex-1 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 text-cyan-400 py-3 rounded-xl text-sm font-medium transition cursor-pointer">
            {copiedLink ? "✓ Copied!" : "Share Link"}
          </button>
          <button onClick={handleCancelOrder}
            className="flex-1 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 py-3 rounded-xl text-sm font-medium transition cursor-pointer">
            Cancel Order
          </button>
        </div>
      )}

      {/* Transaction Modal */}
      <TransactionModal
        open={txModalOpen}
        title={txModalTitle}
        steps={txSteps}
        error={txError}
        onClose={() => { setTxModalOpen(false); setTxError(""); }}
      />
    </div>
  );
}
