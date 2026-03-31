// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title ConfidentialWETH - Wrapped ETH with encrypted balances (ERC7984)
/// @notice Converts ETH into confidential cWETH using OpenZeppelin's ERC7984 base.
///         Encrypted balances use 6-decimal precision (matching FHE_DECIMALS).
///         1 ETH = 1e6 encrypted units. Rate: 1e12 wei per encrypted unit.
contract ConfidentialWETH is ERC7984, ZamaEthereumConfig {
    /// @dev Conversion rate: 1 encrypted unit = 1e12 wei (18 - 6 = 12 decimals)
    uint256 public constant RATE = 1e12;

    mapping(euint64 unwrapAmount => address recipient) private _unwrapRequests;

    event Wrap(address indexed user, uint256 amount);
    event UnwrapRequested(address indexed receiver, euint64 amount);
    event UnwrapFinalized(address indexed receiver, euint64 encryptedAmount, uint64 cleartextAmount);

    error InvalidUnwrapRequest(euint64 amount);

    constructor() ERC7984("Confidential Wrapped ETH", "cWETH", "") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Wrap ETH into cWETH (encrypted balance at 6-decimal precision)
    /// @dev Amount must be a multiple of RATE (1e12 wei) to avoid precision loss
    function wrap() external payable {
        require(msg.value > 0, "Zero amount");
        require(msg.value % RATE == 0, "Exceeds 6 decimal precision");
        _mint(msg.sender, FHE.asEuint64(SafeCast.toUint64(msg.value / RATE)));
        emit Wrap(msg.sender, msg.value);
    }

    /// @notice Request unwrap with encrypted amount - fully confidential
    function unwrap(
        address from,
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external {
        require(from == msg.sender || isOperator(from, msg.sender), ERC7984UnauthorizedSpender(from, msg.sender));
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        _unwrap(from, to, amount);
    }

    /// @notice Request unwrap with plaintext amount (backward compatible)
    /// @param amount Amount in wei (will be converted to 6-decimal)
    function unwrap(uint256 amount) external {
        euint64 encAmount = FHE.asEuint64(SafeCast.toUint64(amount / RATE));
        _unwrap(msg.sender, msg.sender, encAmount);
    }

    /// @dev Internal unwrap: burns encrypted amount, registers finalizeUnwrap request
    function _unwrap(address from, address to, euint64 amount) internal {
        euint64 burntAmount = _burn(from, amount);
        FHE.makePubliclyDecryptable(burntAmount);

        assert(_unwrapRequests[burntAmount] == address(0));
        _unwrapRequests[burntAmount] = to;

        emit UnwrapRequested(to, burntAmount);
    }

    /// @notice Finalize unwrap with decryption proof - sends ETH back
    /// @param burntAmountCleartext The decrypted amount in 6-decimal units
    function finalizeUnwrap(
        euint64 burntAmount,
        uint64 burntAmountCleartext,
        bytes calldata decryptionProof
    ) external {
        address to = _unwrapRequests[burntAmount];
        require(to != address(0), InvalidUnwrapRequest(burntAmount));
        delete _unwrapRequests[burntAmount];

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(burntAmount);
        bytes memory cleartexts = abi.encode(burntAmountCleartext);
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        // Convert 6-decimal back to wei
        (bool sent, ) = payable(to).call{value: uint256(burntAmountCleartext) * RATE}("");
        require(sent, "ETH transfer failed");

        emit UnwrapFinalized(to, burntAmount, burntAmountCleartext);
    }

    /// @notice Plaintext deposit helper for OTC.
    ///         Converts plaintext wei amount to 6-decimal encrypted and transfers.
    /// @param amount The plaintext amount in wei
    function depositFrom(address from, address to, uint256 amount) external returns (bool) {
        require(isOperator(from, msg.sender), ERC7984UnauthorizedSpender(from, msg.sender));
        euint64 encAmount = FHE.asEuint64(SafeCast.toUint64(amount / RATE));
        _transfer(from, to, encAmount);
        return true;
    }

    /// @notice Plaintext transfer helper for OTC (refunds, settlements).
    /// @param amount The plaintext amount in wei
    function depositTransfer(address to, uint256 amount) external returns (bool) {
        euint64 encAmount = FHE.asEuint64(SafeCast.toUint64(amount / RATE));
        _transfer(msg.sender, to, encAmount);
        return true;
    }

    receive() external payable {}
}
