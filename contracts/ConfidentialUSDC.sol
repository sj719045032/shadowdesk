// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

/// @title ConfidentialUSDC - Wrapped USDC with encrypted balances (ERC7984)
/// @notice Converts standard USDC (ERC20) into confidential cUSDC using OpenZeppelin's ERC7984ERC20Wrapper.
///         Inherits wrap(), unwrap(), finalizeUnwrap(), confidentialTransfer, confidentialTransferFrom,
///         confidentialBalanceOf, setOperator, isOperator, and all other ERC7984 standard functions.
contract ConfidentialUSDC is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(IERC20 _underlying)
        ERC7984("Confidential USDC", "cUSDC", "")
        ERC7984ERC20Wrapper(_underlying)
    {}

    /// @notice Plaintext deposit helper for OTC backward compatibility.
    ///         Allows an operator (e.g. the OTC contract) to pull plaintext-amount tokens
    ///         from `from` and credit encrypted balance to `to`.
    /// @dev Caller must be an operator for `from` via setOperator().
    ///      Internally converts the plaintext amount to euint64 and calls _transfer.
    /// @param from The address to debit
    /// @param to The address to credit
    /// @param amount The plaintext amount to transfer
    function depositFrom(address from, address to, uint256 amount) external returns (bool) {
        require(isOperator(from, msg.sender), ERC7984UnauthorizedSpender(from, msg.sender));
        euint64 encAmount = FHE.asEuint64(SafeCast.toUint64(amount / rate()));
        _transfer(from, to, encAmount);
        return true;
    }

    /// @notice Plaintext transfer helper for OTC backward compatibility (refunds, etc.).
    ///         Allows the contract itself to push tokens using a plaintext amount.
    /// @dev Caller must hold the tokens (msg.sender is `from`).
    /// @param to The address to credit
    /// @param amount The plaintext amount to transfer
    function depositTransfer(address to, uint256 amount) external returns (bool) {
        euint64 encAmount = FHE.asEuint64(SafeCast.toUint64(amount / rate()));
        _transfer(msg.sender, to, encAmount);
        return true;
    }
}
