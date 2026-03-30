// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title ConfidentialWETH - Wrapped ETH with encrypted balances (ERC7984)
/// @notice Converts ETH into confidential cWETH using OpenZeppelin's ERC7984 base.
///         Inherits confidentialTransfer, confidentialTransferFrom, confidentialBalanceOf,
///         setOperator, isOperator, and all other ERC7984 standard functions.
///         ETH wrapping/unwrapping is handled with a custom two-phase pattern
///         (unwrap requires FHE decryption via finalizeUnwrap).
contract ConfidentialWETH is ERC7984, ZamaEthereumConfig {
    mapping(euint64 unwrapAmount => address recipient) private _unwrapRequests;

    event Wrap(address indexed user, uint256 amount);
    event UnwrapRequested(address indexed receiver, euint64 amount);
    event UnwrapFinalized(address indexed receiver, euint64 encryptedAmount, uint64 cleartextAmount);

    error InvalidUnwrapRequest(euint64 amount);

    constructor() ERC7984("Confidential Wrapped ETH", "cWETH", "") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @notice Wrap ETH into cWETH (encrypted balance)
    function wrap() external payable {
        require(msg.value > 0, "Zero amount");
        _mint(msg.sender, FHE.asEuint64(SafeCast.toUint64(msg.value)));
        emit Wrap(msg.sender, msg.value);
    }

    /// @notice Request unwrap - burns encrypted amount, needs finalizeUnwrap to complete
    function unwrap(uint256 amount) external {
        euint64 encAmount = FHE.asEuint64(SafeCast.toUint64(amount));
        euint64 burntAmount = _burn(msg.sender, encAmount);
        FHE.makePubliclyDecryptable(burntAmount);

        assert(_unwrapRequests[burntAmount] == address(0));
        _unwrapRequests[burntAmount] = msg.sender;

        emit UnwrapRequested(msg.sender, burntAmount);
    }

    /// @notice Finalize unwrap with decryption proof - sends ETH back
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

        (bool sent, ) = payable(to).call{value: burntAmountCleartext}("");
        require(sent, "ETH transfer failed");

        emit UnwrapFinalized(to, burntAmount, burntAmountCleartext);
    }

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
        euint64 encAmount = FHE.asEuint64(SafeCast.toUint64(amount));
        _transfer(from, to, encAmount);
        return true;
    }

    /// @notice Plaintext transfer helper for OTC backward compatibility (refunds, etc.).
    ///         Allows the contract itself to push tokens using a plaintext amount.
    /// @dev Caller must hold the tokens (msg.sender is `from`).
    /// @param to The address to credit
    /// @param amount The plaintext amount to transfer
    function depositTransfer(address to, uint256 amount) external returns (bool) {
        euint64 encAmount = FHE.asEuint64(SafeCast.toUint64(amount));
        _transfer(msg.sender, to, encAmount);
        return true;
    }

    receive() external payable {}
}
