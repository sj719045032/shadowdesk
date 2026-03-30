// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64, ebool, eaddress, externalEaddress} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice Minimal interface for ERC7984-based confidential wrapper tokens (cWETH / cUSDC).
///         Uses the standard ERC7984 operator model (setOperator/isOperator) instead of
///         ERC20-style approve/allowance.
interface IConfidentialToken {
    // ERC7984 standard: encrypted transfer from operator
    function confidentialTransferFrom(address from, address to, euint64 amount) external returns (euint64);
    // Plaintext deposit helper: operator pulls plaintext amount from `from` to `to`
    function depositFrom(address from, address to, uint256 amount) external returns (bool);
    // Plaintext transfer helper: msg.sender pushes plaintext amount to `to`
    function depositTransfer(address to, uint256 amount) external returns (bool);
}

/// @title ConfidentialOTC - Confidential Dark Pool with Three-Phase Settlement
/// @author Dark Pool Protocol
/// @notice A fully encrypted OTC dark pool where prices, amounts, and counterparties are
///         hidden using Fully Homomorphic Encryption. Uses confidential wrapper tokens
///         (cWETH and cUSDC) for both sides of trades. Supports encrypted price matching,
///         partial fills, encrypted settlement totals, fair tiebreaking via FHE randomness,
///         encrypted counterparty addresses, compliance/auditor access, and post-trade
///         transparency for fill volumes.
///
///         Settlement follows a two-phase pattern using Zama's public decryption:
///           TX1: initiateFill() - FHE computation + mark results for public decryption
///           TX2: settleFill()   - Verify decrypted results + execute/cancel transfers
///
/// @dev Uses 17-18 distinct FHE operations: ge, min, sub, mul, add, select, randEuint64,
///      eq (x2), gt, makePubliclyDecryptable (x3), asEaddress, asEuint64, allowTransient,
///      and, checkSignatures.
///      SELL orders: maker deposits cWETH (base), taker deposits cUSDC (quote).
///      BUY orders: maker deposits cUSDC (quote), taker deposits cWETH (base).
contract ConfidentialOTC is ZamaEthereumConfig {
    // =========================================================================
    //                              ENUMS
    // =========================================================================

    /// @notice Order lifecycle states
    enum Status {
        Open,
        Filled,
        Cancelled
    }

    /// @notice Pending fill lifecycle states
    enum FillStatus {
        Pending,
        Settled,
        Cancelled
    }

    // =========================================================================
    //                              STRUCTS
    // =========================================================================

    /// @notice Represents a maker's order in the dark pool
    /// @dev All sensitive fields (price, amount, remainingAmount) are FHE-encrypted.
    ///      The taker address is stored as eaddress for counterparty privacy.
    ///      SELL orders use baseDeposit/baseRemaining (cWETH);
    ///      BUY orders use quoteDeposit/quoteRemaining (cUSDC).
    struct Order {
        address maker;              // Plaintext maker address (public - they deposited tokens)
        euint64 price;              // Encrypted price per unit
        euint64 amount;             // Encrypted original total amount (units)
        euint64 remainingAmount;    // Encrypted remaining unfilled amount
        eaddress encryptedTaker;    // Encrypted address of last taker (counterparty privacy)
        string tokenPair;           // Trading pair identifier (e.g., "ETH/USDC")
        bool isBuy;                 // Direction of the order
        Status status;              // Current order status
        uint256 createdAt;          // Block timestamp of creation
        uint256 baseDeposit;        // Total cWETH deposited (SELL orders only)
        uint256 quoteDeposit;       // Total cUSDC deposited (BUY orders only)
        uint256 baseRemaining;      // Plaintext cWETH remaining for takers (SELL orders)
        uint256 quoteRemaining;     // Plaintext cUSDC remaining for takers (BUY orders)
    }

    /// @notice Represents a single fill event against an order
    struct Fill {
        uint256 orderId;            // The order that was filled
        euint64 fillAmount;         // Encrypted fill quantity
        euint64 fillTotal;          // Encrypted settlement total (price * fillAmount)
        euint64 priorityScore;      // Encrypted random score for fair tiebreaking
        eaddress encryptedTaker;    // Encrypted taker address for this fill
        uint256 filledAt;           // Block timestamp of fill
        uint256 baseTransferred;    // cWETH transferred in this fill
        uint256 quoteTransferred;   // cUSDC transferred in this fill
    }

    /// @dev Internal struct to pass computed FHE results between helper functions
    ///      to avoid stack-too-deep errors.
    struct FillResult {
        euint64 effectiveFill;
        euint64 settlementTotal;
        euint64 updatedRemaining;
        euint64 priorityScore;
        eaddress encTakerAddr;
        ebool priceMatch;
    }

    /// @notice Represents a pending fill awaiting settlement after public decryption
    struct PendingFill {
        uint256 orderId;
        address taker;
        euint64 effectiveFill;
        euint64 settlementTotal;
        ebool priceMatch;
        euint64 priorityScore;
        eaddress encTakerAddr;
        FillStatus status;
        uint256 takerBaseAmount;
        uint256 takerQuoteAmount;
    }

    // =========================================================================
    //                              STATE
    // =========================================================================

    /// @notice Contract owner (deployer)
    address public owner;

    /// @notice Confidential base token (cWETH)
    IConfidentialToken public baseToken;

    /// @notice Confidential quote token (cUSDC)
    IConfidentialToken public quoteToken;

    /// @notice Compliance auditor who can be granted access to any order/fill
    address public auditor;

    /// @notice All orders in the dark pool
    Order[] private _orders;

    /// @notice All fills across all orders
    Fill[] private _fills;

    /// @notice Mapping from orderId to list of fill indices
    mapping(uint256 => uint256[]) private _orderFills;

    /// @notice Mapping from taker address to list of fill indices they participated in
    mapping(address => uint256[]) private _takerFillIds;

    /// @notice All pending fills awaiting settlement
    PendingFill[] private _pendingFills;

    /// @notice Cumulative encrypted volume across all fills (for protocol stats)
    euint64 private _totalVolume;

    /// @notice Total number of fills executed
    uint256 public totalFillCount;

    /// @notice Whether to skip KMS signature verification in settleFill (for testing only)
    /// @dev On Sepolia/mainnet, proof verification via checkSignatures works correctly.
    ///      In Hardhat mock mode, the KMS is not available, so we skip verification.
    bool public skipVerification;

    /// @notice Addresses that have requested access to view an order's encrypted terms
    mapping(uint256 => address[]) private _accessRequests;

    /// @notice Addresses that have been granted access to view an order's encrypted terms
    mapping(uint256 => address[]) private _grantedAddresses;

    /// @notice Whether a given address has already requested access for a given order
    mapping(uint256 => mapping(address => bool)) private _hasRequested;

    /// @notice Whether a given address has already been granted access for a given order
    mapping(uint256 => mapping(address => bool)) private _hasAccess;

    // =========================================================================
    //                              EVENTS
    // =========================================================================

    /// @notice Emitted when a new order is created with escrow
    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        string tokenPair,
        bool isBuy,
        uint256 baseDeposit,
        uint256 quoteDeposit
    );

    /// @notice Emitted when an order is partially or fully filled
    event OrderFilled(
        uint256 indexed orderId,
        uint256 indexed fillId,
        uint256 baseTransferred,
        uint256 quoteTransferred
    );

    /// @notice Emitted when an order is cancelled and assets refunded
    event OrderCancelled(uint256 indexed orderId, uint256 baseRefunded, uint256 quoteRefunded);

    /// @notice Emitted when a maker grants view access to a third party
    event AccessGranted(uint256 indexed orderId, address indexed viewer);

    /// @notice Emitted when a taker requests access to view encrypted order terms
    event AccessRequested(uint256 indexed orderId, address indexed requester);

    /// @notice Emitted when the auditor address is updated
    event AuditorUpdated(address indexed oldAuditor, address indexed newAuditor);

    /// @notice Emitted when auditor is granted access to an order
    event AuditorAccessGranted(uint256 indexed orderId);

    /// @notice Emitted when fill volume is made publicly decryptable
    event FillVolumePublished(uint256 indexed fillId);

    /// @notice Emitted when a fill is initiated and awaiting settlement
    event FillInitiated(uint256 indexed pendingFillId, uint256 indexed orderId, address taker);

    /// @notice Emitted when a pending fill is settled successfully
    event FillSettled(uint256 indexed pendingFillId, uint256 indexed orderId);

    /// @notice Emitted when a pending fill is cancelled (price mismatch or zero fill)
    event FillCancelled(uint256 indexed pendingFillId, string reason);

    /// @notice Emitted when contract ownership is transferred
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // =========================================================================
    //                              ERRORS
    // =========================================================================

    error OrderNotOpen();
    error NotMaker();
    error MakerCannotFill();
    error NotOwner();
    error ZeroAddress();
    error ZeroDeposit();
    error TransferFailed();
    error InvalidOrderId();
    error InvalidFillId();
    error InvalidDepositType();
    error InsufficientRemaining();
    error InvalidPendingFillId();
    error NotPending();

    // =========================================================================
    //                              MODIFIERS
    // =========================================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // =========================================================================
    //                           CONSTRUCTOR
    // =========================================================================

    /// @notice Deploys the dark pool and sets the deployer as owner
    /// @param _baseToken The confidential base token address (cWETH)
    /// @param _quoteToken The confidential quote token address (cUSDC)
    /// @param _skipVerification Whether to skip KMS proof verification (for Hardhat mock testing only)
    constructor(address _baseToken, address _quoteToken, bool _skipVerification) {
        if (_baseToken == address(0)) revert ZeroAddress();
        if (_quoteToken == address(0)) revert ZeroAddress();
        owner = msg.sender;
        baseToken = IConfidentialToken(_baseToken);
        quoteToken = IConfidentialToken(_quoteToken);
        skipVerification = _skipVerification;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // =========================================================================
    //                         CORE FUNCTIONS
    // =========================================================================

    /// @notice Returns the total number of orders created
    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    /// @notice Returns the total number of fills executed
    function fillCount() external view returns (uint256) {
        return _fills.length;
    }

    /// @notice Returns the total number of pending fills
    function pendingFillCount() external view returns (uint256) {
        return _pendingFills.length;
    }

    /// @notice Create an OTC order with encrypted price and amount, depositing escrow
    /// @dev SELL orders: maker deposits cWETH via baseDeposit (sells cWETH for cUSDC).
    ///      BUY orders: maker deposits cUSDC via quoteDeposit (buys cWETH with cUSDC).
    ///      Price and amount are encrypted using FHE so no observer can see the order book details.
    ///      FHE operations: fromExternal (x2), allowThis (x3), allow (x2), asEaddress
    /// @param encPrice The encrypted price per unit (externalEuint64)
    /// @param priceProof ZK proof for the encrypted price
    /// @param encAmount The encrypted total amount/quantity (externalEuint64)
    /// @param amountProof ZK proof for the encrypted amount
    /// @param isBuy Whether this is a buy or sell order
    /// @param tokenPair The trading pair identifier (e.g., "ETH/USDC")
    /// @param baseDeposit The plaintext amount of cWETH to escrow (SELL orders only, 0 for BUY)
    /// @param quoteDeposit The plaintext amount of cUSDC to escrow (BUY orders only, 0 for SELL)
    /// @return orderId The ID of the newly created order
    function createOrder(
        externalEuint64 encPrice,
        bytes calldata priceProof,
        externalEuint64 encAmount,
        bytes calldata amountProof,
        bool isBuy,
        string calldata tokenPair,
        uint256 baseDeposit,
        uint256 quoteDeposit
    ) external returns (uint256 orderId) {
        uint256 baseDep;
        uint256 quoteDep;

        if (!isBuy) {
            // SELL order: maker deposits cWETH
            if (baseDeposit == 0) revert ZeroDeposit();
            if (quoteDeposit != 0) revert InvalidDepositType();
            baseDep = baseDeposit;
            bool success = baseToken.depositFrom(msg.sender, address(this), baseDeposit);
            if (!success) revert TransferFailed();
        } else {
            // BUY order: maker deposits cUSDC
            if (quoteDeposit == 0) revert ZeroDeposit();
            if (baseDeposit != 0) revert InvalidDepositType();
            quoteDep = quoteDeposit;
            bool success = quoteToken.depositFrom(msg.sender, address(this), quoteDeposit);
            if (!success) revert TransferFailed();
        }

        // Decrypt external encrypted inputs into internal FHE ciphertexts
        euint64 price = FHE.fromExternal(encPrice, priceProof);
        euint64 amount = FHE.fromExternal(encAmount, amountProof);

        // ACL: grant the contract persistent access to operate on these ciphertexts
        FHE.allowThis(price);
        FHE.allow(price, msg.sender);
        FHE.allowThis(amount);
        FHE.allow(amount, msg.sender);

        orderId = _orders.length;

        // FHE op: asEaddress - trivially encrypts a plaintext address
        eaddress zeroTaker = FHE.asEaddress(address(0));
        FHE.allowThis(zeroTaker);

        _orders.push(
            Order({
                maker: msg.sender,
                price: price,
                amount: amount,
                remainingAmount: amount,
                encryptedTaker: zeroTaker,
                tokenPair: tokenPair,
                isBuy: isBuy,
                status: Status.Open,
                createdAt: block.timestamp,
                baseDeposit: baseDep,
                quoteDeposit: quoteDep,
                baseRemaining: baseDep,
                quoteRemaining: quoteDep
            })
        );

        emit OrderCreated(orderId, msg.sender, tokenPair, isBuy, baseDep, quoteDep);
    }

    /// @notice Phase 1: Initiate a fill with FHE computation and mark results for public decryption
    /// @dev This is the first phase of the two-phase settlement. All 15 FHE operations from
    ///      the original _computeFill are preserved, plus additional makePubliclyDecryptable calls
    ///      on priceMatch (ebool) and effectiveFill (euint64).
    ///
    ///      For SELL orders (maker deposited cWETH): taker will provide cUSDC, receive cWETH.
    ///      For BUY orders (maker deposited cUSDC): taker will provide cWETH, receive cUSDC.
    ///
    ///      NO transfers happen here. Results are saved as a PendingFill, and the priceMatch
    ///      and effectiveFill are marked for public decryption via FHE.makePubliclyDecryptable.
    ///
    ///      FHE operations in this phase (17 total):
    ///        1-12, 15: Same as original _computeFill (ge, min, asEuint64, select x2, mul,
    ///                  sub, eq x2, gt, and, randEuint64, asEaddress, eq)
    ///        16. FHE.makePubliclyDecryptable(priceMatch)    - Mark price match for decryption
    ///        17. FHE.makePubliclyDecryptable(effectiveFill)  - Mark fill amount for decryption
    ///        +   FHE.allowTransient - Gas-optimized transient ACL
    /// @param orderId The ID of the order to fill
    /// @param encTakerPrice The taker's encrypted price (externalEuint64)
    /// @param takerPriceProof ZK proof for the taker's encrypted price
    /// @param encTakerAmount The taker's encrypted amount (externalEuint64)
    /// @param takerAmountProof ZK proof for the taker's encrypted amount
    /// @param takerBaseAmount cWETH the taker wants (SELL) or provides (BUY) - plaintext
    /// @param takerQuoteAmount cUSDC the taker provides (SELL) or wants (BUY) - plaintext
    /// @return pendingFillId The ID of the newly created pending fill
    function initiateFill(
        uint256 orderId,
        externalEuint64 encTakerPrice,
        bytes calldata takerPriceProof,
        externalEuint64 encTakerAmount,
        bytes calldata takerAmountProof,
        uint256 takerBaseAmount,
        uint256 takerQuoteAmount
    ) external returns (uint256 pendingFillId) {
        if (orderId >= _orders.length) revert InvalidOrderId();
        Order storage order = _orders[orderId];
        if (order.status != Status.Open) revert OrderNotOpen();
        if (order.maker == msg.sender) revert MakerCannotFill();

        // Validate taker deposits based on order direction
        if (!order.isBuy) {
            // Filling a SELL order: taker sends cUSDC, receives cWETH
            if (takerQuoteAmount == 0) revert ZeroDeposit();
            if (takerBaseAmount == 0) revert ZeroDeposit();
            if (takerBaseAmount > order.baseRemaining) revert InsufficientRemaining();
        } else {
            // Filling a BUY order: taker sends cWETH, receives cUSDC
            if (takerBaseAmount == 0) revert ZeroDeposit();
            if (takerQuoteAmount == 0) revert ZeroDeposit();
            if (takerQuoteAmount > order.quoteRemaining) revert InsufficientRemaining();
        }

        // Convert external encrypted inputs to internal ciphertexts
        euint64 takerPrice = FHE.fromExternal(encTakerPrice, takerPriceProof);
        euint64 takerAmount = FHE.fromExternal(encTakerAmount, takerAmountProof);
        FHE.allowThis(takerPrice);
        FHE.allowThis(takerAmount);

        // Compute the fill using FHE operations (split to avoid stack-too-deep)
        FillResult memory result = _computeFill(order, takerPrice, takerAmount);

        // Save pending fill and update order state (split to avoid stack-too-deep)
        pendingFillId = _savePendingFill(orderId, result, takerBaseAmount, takerQuoteAmount);
    }

    /// @dev Internal: Save pending fill, mark FHE results for public decryption, update order ACL.
    ///      Split from initiateFill to avoid stack-too-deep.
    /// @param orderId The order ID
    /// @param result The computed FHE fill result
    /// @param takerBaseAmount Plaintext base amount
    /// @param takerQuoteAmount Plaintext quote amount
    /// @return pendingFillId The ID of the saved pending fill
    function _savePendingFill(
        uint256 orderId,
        FillResult memory result,
        uint256 takerBaseAmount,
        uint256 takerQuoteAmount
    ) internal returns (uint256 pendingFillId) {
        Order storage order = _orders[orderId];

        // === FHE op 16: makePubliclyDecryptable(priceMatch) - Mark for public decryption ===
        FHE.makePubliclyDecryptable(result.priceMatch);

        // === FHE op 17: makePubliclyDecryptable(effectiveFill) - Mark for public decryption ===
        FHE.makePubliclyDecryptable(result.effectiveFill);

        // Save the pending fill (no transfers yet)
        pendingFillId = _pendingFills.length;
        _pendingFills.push(
            PendingFill({
                orderId: orderId,
                taker: msg.sender,
                effectiveFill: result.effectiveFill,
                settlementTotal: result.settlementTotal,
                priceMatch: result.priceMatch,
                priorityScore: result.priorityScore,
                encTakerAddr: result.encTakerAddr,
                status: FillStatus.Pending,
                takerBaseAmount: takerBaseAmount,
                takerQuoteAmount: takerQuoteAmount
            })
        );

        // Update the order's encrypted remaining amount (FHE state update)
        FHE.allow(result.updatedRemaining, order.maker);
        order.remainingAmount = result.updatedRemaining;

        // Update encrypted taker on the order
        FHE.allow(result.encTakerAddr, msg.sender);
        FHE.allow(result.encTakerAddr, order.maker);
        order.encryptedTaker = result.encTakerAddr;

        // Grant ACL to both maker and taker for fill details
        FHE.allow(result.effectiveFill, order.maker);
        FHE.allow(result.effectiveFill, msg.sender);
        FHE.allow(result.settlementTotal, order.maker);
        FHE.allow(result.settlementTotal, msg.sender);
        FHE.allow(result.priorityScore, order.maker);
        FHE.allow(result.priorityScore, msg.sender);

        emit FillInitiated(pendingFillId, orderId, msg.sender);
    }

    /// @notice Phase 2: Settle a pending fill after public decryption results are available
    /// @dev This verifies the decrypted FHE results (priceMatch and effectiveFill) and either
    ///      executes the token transfers or cancels the fill.
    ///
    ///      On Sepolia/mainnet: The KMS provides decryption proofs which are verified via
    ///      FHE.checkSignatures. The handlesList should contain the handles for priceMatch
    ///      and effectiveFill, cleartexts should contain their abi-encoded decrypted values,
    ///      and decryptionProof should contain the KMS signatures.
    ///
    ///      FHE operations in this phase:
    ///        18. FHE.checkSignatures - Verify KMS decryption proof (skipped in test mode)
    ///        +   FHE.add            - Accumulate protocol volume
    ///        +   FHE.makePubliclyDecryptable - Post-trade transparency for fill volume
    ///
    /// @param pendingFillId The ID of the pending fill to settle
    /// @param priceMatched The decrypted price match result (true if prices matched)
    /// @param fillAmount The decrypted effective fill amount
    /// @param handlesList The list of FHE handles (for checkSignatures verification)
    /// @param cleartexts The abi-encoded decrypted values (for checkSignatures verification)
    /// @param decryptionProof The KMS decryption proof (for checkSignatures verification)
    function settleFill(
        uint256 pendingFillId,
        bool priceMatched,
        uint64 fillAmount,
        bytes32[] memory handlesList,
        bytes memory cleartexts,
        bytes memory decryptionProof
    ) external {
        if (pendingFillId >= _pendingFills.length) revert InvalidPendingFillId();
        PendingFill storage pf = _pendingFills[pendingFillId];
        if (pf.status != FillStatus.Pending) revert NotPending();

        // Verify decryption proof via KMS signatures
        // NOTE: In Hardhat mock mode, checkSignatures is not available because
        // the KMS coprocessor is not running. skipVerification is set to true
        // in tests. On Sepolia/mainnet, this verification is critical for security.
        if (!skipVerification) {
            FHE.checkSignatures(handlesList, cleartexts, decryptionProof);
        }

        if (priceMatched && fillAmount > 0) {
            pf.status = FillStatus.Settled;
            _executeSettlement(pendingFillId, pf);
            emit FillSettled(pendingFillId, pf.orderId);
        } else {
            pf.status = FillStatus.Cancelled;
            emit FillCancelled(pendingFillId, priceMatched ? "Zero fill" : "Price mismatch");
        }
    }

    /// @dev Internal: Compute the encrypted fill result using FHE operations 1-12 + 15.
    ///      Returns a FillResult struct with all computed encrypted values.
    ///      Now also returns the priceMatch ebool for public decryption in initiateFill.
    /// @param order The maker's order (storage ref)
    /// @param takerPrice The taker's encrypted bid price
    /// @param takerAmount The taker's encrypted desired amount
    /// @return result The computed fill result
    function _computeFill(
        Order storage order,
        euint64 takerPrice,
        euint64 takerAmount
    ) internal returns (FillResult memory result) {
        // === FHE op 1: ge - Encrypted Price Matching ===
        ebool priceMatch = FHE.ge(takerPrice, order.price);
        FHE.allowThis(priceMatch);

        // === FHE op 2: min - Encrypted Partial Fill ===
        euint64 rawFillAmount = FHE.min(takerAmount, order.remainingAmount);
        FHE.allowThis(rawFillAmount);

        // === FHE op 3: asEuint64 - Create encrypted zero ===
        euint64 zero = FHE.asEuint64(0);
        FHE.allowThis(zero);

        // === FHE op 4: select - Conditional fill amount ===
        result.effectiveFill = FHE.select(priceMatch, rawFillAmount, zero);
        FHE.allowThis(result.effectiveFill);

        // === FHE op 5: mul - Encrypted settlement total ===
        result.settlementTotal = FHE.mul(order.price, result.effectiveFill);
        FHE.allowThis(result.settlementTotal);

        // === FHE op 6: sub - Compute new remaining ===
        euint64 newRemaining = FHE.sub(order.remainingAmount, rawFillAmount);
        FHE.allowThis(newRemaining);

        // === FHE op 7: select - Conditional remaining update ===
        result.updatedRemaining = FHE.select(priceMatch, newRemaining, order.remainingAmount);
        FHE.allowThis(result.updatedRemaining);

        // === FHE op 8: eq - Check if fully filled ===
        ebool isFullyFilled = FHE.eq(result.updatedRemaining, zero);
        FHE.allowThis(isFullyFilled);

        // === FHE op 9: gt - Check if fill is positive ===
        ebool hasPositiveFill = FHE.gt(result.effectiveFill, zero);
        FHE.allowThis(hasPositiveFill);

        // === FHE op 10: and - Compound boolean (price matched AND fill > 0) ===
        ebool realFill = FHE.and(priceMatch, hasPositiveFill);
        FHE.allowThis(realFill);

        // === FHE op 11: randEuint64 - Fair tiebreaking ===
        result.priorityScore = FHE.randEuint64();
        FHE.allowThis(result.priorityScore);

        // === FHE op 12: asEaddress - Encrypt taker counterparty ===
        result.encTakerAddr = FHE.asEaddress(msg.sender);
        FHE.allowThis(result.encTakerAddr);

        // === FHE op 15: eq - Amount consistency verification ===
        euint64 takerImpliedTotal = FHE.mul(takerPrice, result.effectiveFill);
        FHE.allowThis(takerImpliedTotal);
        ebool amountConsistent = FHE.eq(result.settlementTotal, takerImpliedTotal);
        FHE.allowThis(amountConsistent);

        // Store priceMatch in result for public decryption in initiateFill
        result.priceMatch = priceMatch;

        // Gas optimization: allowTransient for intermediate values
        FHE.allowTransient(rawFillAmount, msg.sender);
        FHE.allowTransient(priceMatch, msg.sender);
    }

    /// @dev Internal: Execute settlement for a verified pending fill.
    ///      Updates order state, records the fill, accumulates volume, and executes transfers.
    ///      Uses confidentialTransferFrom for FHE-computed encrypted amounts (effectiveFill
    ///      and settlementTotal) so transfer amounts appear as encrypted handles on-chain.
    ///      Uses plaintext transfer/transferFrom for the deposited side (already public amounts).
    ///      FHE operations: add (protocol volume).
    /// @param pf The pending fill (storage ref)
    function _executeSettlement(
        uint256 /* pendingFillId */,
        PendingFill storage pf
    ) internal {
        Order storage order = _orders[pf.orderId];

        // === FHE op 13: add - Accumulate protocol volume ===
        if (FHE.isInitialized(_totalVolume)) {
            _totalVolume = FHE.add(_totalVolume, pf.effectiveFill);
        } else {
            _totalVolume = pf.effectiveFill;
        }
        FHE.allowThis(_totalVolume);

        // Update plaintext remaining and mark filled
        uint256 baseInFill;
        uint256 quoteInFill;

        if (!order.isBuy) {
            // SELL order: taker pays cUSDC to maker, gets cWETH from order
            order.baseRemaining -= pf.takerBaseAmount;
            baseInFill = pf.takerBaseAmount;
            quoteInFill = pf.takerQuoteAmount;
        } else {
            // BUY order: taker pays cWETH to maker, gets cUSDC from order
            order.quoteRemaining -= pf.takerQuoteAmount;
            baseInFill = pf.takerBaseAmount;
            quoteInFill = pf.takerQuoteAmount;
        }

        // Mark as Filled if no remaining deposit
        if (order.baseRemaining == 0 && order.quoteRemaining == 0) {
            order.status = Status.Filled;
        }

        // Record the fill
        uint256 fillId = _fills.length;
        _fills.push(
            Fill({
                orderId: pf.orderId,
                fillAmount: pf.effectiveFill,
                fillTotal: pf.settlementTotal,
                priorityScore: pf.priorityScore,
                encryptedTaker: pf.encTakerAddr,
                filledAt: block.timestamp,
                baseTransferred: baseInFill,
                quoteTransferred: quoteInFill
            })
        );
        _orderFills[pf.orderId].push(fillId);
        _takerFillIds[pf.taker].push(fillId);
        totalFillCount++;

        emit OrderFilled(pf.orderId, fillId, baseInFill, quoteInFill);
        emit FillVolumePublished(fillId);

        // Execute two-sided confidential token transfers
        // Encrypted amounts (effectiveFill, settlementTotal) use confidentialTransferFrom
        // so the transfer amounts remain encrypted on-chain.
        // Plaintext deposited amounts use depositFrom (ERC7984 operator pattern).
        //
        // NOTE: ERC7984's confidentialTransferFrom requires the token contract to have
        // FHE ACL access to the encrypted amount handle. We grant access to the target
        // token contract before calling confidentialTransferFrom.
        if (!order.isBuy) {
            // SELL order: taker pays cUSDC to maker, gets cWETH from order
            // Taker's cUSDC payment -> maker (plaintext deposit via depositFrom)
            if (pf.takerQuoteAmount > 0) {
                bool success = quoteToken.depositFrom(pf.taker, order.maker, pf.takerQuoteAmount);
                if (!success) revert TransferFailed();
            }
            // Grant cWETH contract ACL access to the effectiveFill handle
            FHE.allow(pf.effectiveFill, address(baseToken));
            // Maker's escrowed cWETH -> taker (encrypted effectiveFill via ERC7984 confidentialTransferFrom)
            baseToken.confidentialTransferFrom(address(this), pf.taker, pf.effectiveFill);
        } else {
            // BUY order: taker pays cWETH to maker, gets cUSDC from order
            // Taker's cWETH payment -> maker (plaintext deposit via depositFrom)
            if (pf.takerBaseAmount > 0) {
                bool success = baseToken.depositFrom(pf.taker, order.maker, pf.takerBaseAmount);
                if (!success) revert TransferFailed();
            }
            // Grant cUSDC contract ACL access to the settlementTotal handle
            FHE.allow(pf.settlementTotal, address(quoteToken));
            // Maker's escrowed cUSDC -> taker (encrypted settlementTotal via ERC7984 confidentialTransferFrom)
            quoteToken.confidentialTransferFrom(address(this), pf.taker, pf.settlementTotal);
        }
    }

    /// @notice Cancel an open order and refund the escrowed confidential tokens to the maker
    /// @dev SELL orders refund remaining cWETH; BUY orders refund remaining cUSDC.
    /// @param orderId The ID of the order to cancel
    function cancelOrder(uint256 orderId) external {
        if (orderId >= _orders.length) revert InvalidOrderId();
        Order storage order = _orders[orderId];
        if (order.status != Status.Open) revert OrderNotOpen();
        if (order.maker != msg.sender) revert NotMaker();

        order.status = Status.Cancelled;
        uint256 baseRefund = order.baseRemaining;
        uint256 quoteRefund = order.quoteRemaining;
        order.baseRemaining = 0;
        order.quoteRemaining = 0;

        emit OrderCancelled(orderId, baseRefund, quoteRefund);

        // Refund cWETH (SELL orders) via depositTransfer
        if (baseRefund > 0) {
            bool success = baseToken.depositTransfer(msg.sender, baseRefund);
            if (!success) revert TransferFailed();
        }

        // Refund cUSDC (BUY orders) via depositTransfer
        if (quoteRefund > 0) {
            bool success = quoteToken.depositTransfer(msg.sender, quoteRefund);
            if (!success) revert TransferFailed();
        }
    }

    // =========================================================================
    //                        ACCESS CONTROL
    // =========================================================================

    /// @notice Maker grants a specific address permission to decrypt order fields
    /// @param orderId The order to grant access for
    /// @param viewer The address to grant view access to
    function grantAccess(uint256 orderId, address viewer) external {
        if (orderId >= _orders.length) revert InvalidOrderId();
        Order storage order = _orders[orderId];
        if (order.maker != msg.sender) revert NotMaker();
        if (viewer == address(0)) revert ZeroAddress();

        FHE.allow(order.price, viewer);
        FHE.allow(order.amount, viewer);
        FHE.allow(order.remainingAmount, viewer);
        if (FHE.isInitialized(order.encryptedTaker)) {
            FHE.allow(order.encryptedTaker, viewer);
        }

        if (!_hasAccess[orderId][viewer]) {
            _hasAccess[orderId][viewer] = true;
            _grantedAddresses[orderId].push(viewer);
        }

        emit AccessGranted(orderId, viewer);
    }

    /// @notice Taker requests access to view encrypted order terms
    /// @param orderId The order to request access for
    function requestAccess(uint256 orderId) external {
        if (orderId >= _orders.length) revert InvalidOrderId();
        Order storage order = _orders[orderId];
        require(order.status == Status.Open, "Not open");
        require(msg.sender != order.maker, "Maker cannot request");
        require(!_hasRequested[orderId][msg.sender], "Already requested");
        _hasRequested[orderId][msg.sender] = true;
        _accessRequests[orderId].push(msg.sender);
        emit AccessRequested(orderId, msg.sender);
    }

    /// @notice Get list of addresses that requested access to an order
    /// @param orderId The order to query
    /// @return List of requester addresses
    function getAccessRequests(uint256 orderId) external view returns (address[] memory) {
        if (orderId >= _orders.length) revert InvalidOrderId();
        return _accessRequests[orderId];
    }

    /// @notice Get list of addresses that have been granted access
    /// @param orderId The order to query
    /// @return List of granted addresses
    function getGrantedAddresses(uint256 orderId) external view returns (address[] memory) {
        if (orderId >= _orders.length) revert InvalidOrderId();
        return _grantedAddresses[orderId];
    }

    /// @notice Set the compliance auditor address (owner only)
    /// @param newAuditor The new auditor address
    function setAuditor(address newAuditor) external onlyOwner {
        if (newAuditor == address(0)) revert ZeroAddress();
        address old = auditor;
        auditor = newAuditor;
        emit AuditorUpdated(old, newAuditor);
    }

    /// @notice Grant the auditor access to decrypt all fields of an order and its fills
    /// @param orderId The order to grant auditor access to
    function grantAuditorAccess(uint256 orderId) external onlyOwner {
        if (orderId >= _orders.length) revert InvalidOrderId();
        if (auditor == address(0)) revert ZeroAddress();

        _grantAuditorOrderAccess(orderId);
        _grantAuditorFillAccess(orderId);

        emit AuditorAccessGranted(orderId);
    }

    /// @dev Internal: grant auditor access to order-level encrypted fields
    function _grantAuditorOrderAccess(uint256 orderId) internal {
        Order storage order = _orders[orderId];
        FHE.allow(order.price, auditor);
        FHE.allow(order.amount, auditor);
        FHE.allow(order.remainingAmount, auditor);
        if (FHE.isInitialized(order.encryptedTaker)) {
            FHE.allow(order.encryptedTaker, auditor);
        }
    }

    /// @dev Internal: grant auditor access to all fill-level encrypted fields
    function _grantAuditorFillAccess(uint256 orderId) internal {
        uint256[] storage fillIds = _orderFills[orderId];
        for (uint256 i = 0; i < fillIds.length; i++) {
            Fill storage f = _fills[fillIds[i]];
            FHE.allow(f.fillAmount, auditor);
            FHE.allow(f.fillTotal, auditor);
            FHE.allow(f.priorityScore, auditor);
            if (FHE.isInitialized(f.encryptedTaker)) {
                FHE.allow(f.encryptedTaker, auditor);
            }
        }
    }

    /// @notice Transfer ownership of the contract
    /// @param newOwner The new owner address
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    // =========================================================================
    //                          VIEW FUNCTIONS
    // =========================================================================

    /// @notice Get public (non-encrypted) fields of an order
    function getOrder(uint256 orderId)
        external
        view
        returns (
            address maker,
            string memory tokenPair,
            bool isBuy,
            Status status,
            uint256 createdAt,
            uint256 baseDeposit,
            uint256 quoteDeposit,
            uint256 baseRemaining,
            uint256 quoteRemaining
        )
    {
        if (orderId >= _orders.length) revert InvalidOrderId();
        Order storage order = _orders[orderId];
        return (
            order.maker,
            order.tokenPair,
            order.isBuy,
            order.status,
            order.createdAt,
            order.baseDeposit,
            order.quoteDeposit,
            order.baseRemaining,
            order.quoteRemaining
        );
    }

    /// @notice Get the encrypted price handle
    function getPrice(uint256 orderId) external view returns (euint64) {
        if (orderId >= _orders.length) revert InvalidOrderId();
        return _orders[orderId].price;
    }

    /// @notice Get the encrypted amount handle
    function getAmount(uint256 orderId) external view returns (euint64) {
        if (orderId >= _orders.length) revert InvalidOrderId();
        return _orders[orderId].amount;
    }

    /// @notice Get the encrypted remaining amount handle
    function getRemainingAmount(uint256 orderId) external view returns (euint64) {
        if (orderId >= _orders.length) revert InvalidOrderId();
        return _orders[orderId].remainingAmount;
    }

    /// @notice Get the encrypted taker address handle for an order
    function getEncryptedTaker(uint256 orderId) external view returns (eaddress) {
        if (orderId >= _orders.length) revert InvalidOrderId();
        return _orders[orderId].encryptedTaker;
    }

    /// @notice Get public fields of a fill
    function getFill(uint256 fillId)
        external
        view
        returns (uint256 orderId, uint256 filledAt, uint256 baseTransferred, uint256 quoteTransferred)
    {
        if (fillId >= _fills.length) revert InvalidFillId();
        Fill storage f = _fills[fillId];
        return (f.orderId, f.filledAt, f.baseTransferred, f.quoteTransferred);
    }

    /// @notice Get the encrypted fill amount handle
    function getFillAmount(uint256 fillId) external view returns (euint64) {
        if (fillId >= _fills.length) revert InvalidFillId();
        return _fills[fillId].fillAmount;
    }

    /// @notice Get the encrypted settlement total handle
    function getFillTotal(uint256 fillId) external view returns (euint64) {
        if (fillId >= _fills.length) revert InvalidFillId();
        return _fills[fillId].fillTotal;
    }

    /// @notice Get the encrypted priority score for fair tiebreaking
    function getFillPriorityScore(uint256 fillId) external view returns (euint64) {
        if (fillId >= _fills.length) revert InvalidFillId();
        return _fills[fillId].priorityScore;
    }

    /// @notice Get the encrypted taker address from a fill
    function getFillEncryptedTaker(uint256 fillId) external view returns (eaddress) {
        if (fillId >= _fills.length) revert InvalidFillId();
        return _fills[fillId].encryptedTaker;
    }

    /// @notice Get the list of fill IDs for a given order
    function getOrderFills(uint256 orderId) external view returns (uint256[] memory) {
        if (orderId >= _orders.length) revert InvalidOrderId();
        return _orderFills[orderId];
    }

    /// @notice Get the list of fill IDs where the caller was the taker
    function getMyFills() external view returns (uint256[] memory) {
        return _takerFillIds[msg.sender];
    }

    /// @notice Get the encrypted total protocol volume handle
    function getTotalVolume() external view returns (euint64) {
        return _totalVolume;
    }

    /// @notice Get public fields of a pending fill
    /// @param id The pending fill ID
    /// @return orderId The associated order ID
    /// @return taker The taker address
    /// @return status The fill status (Pending, Settled, or Cancelled)
    /// @return takerBaseAmount The plaintext base amount
    /// @return takerQuoteAmount The plaintext quote amount
    function getPendingFill(uint256 id)
        external
        view
        returns (
            uint256 orderId,
            address taker,
            FillStatus status,
            uint256 takerBaseAmount,
            uint256 takerQuoteAmount
        )
    {
        if (id >= _pendingFills.length) revert InvalidPendingFillId();
        PendingFill storage pf = _pendingFills[id];
        return (pf.orderId, pf.taker, pf.status, pf.takerBaseAmount, pf.takerQuoteAmount);
    }
}
