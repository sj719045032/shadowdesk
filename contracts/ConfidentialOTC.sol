// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, externalEuint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title ConfidentialOTC - Private OTC Trading with FHE
/// @notice Encrypted price & amount prevent front-running and information leakage.
///         Only counterparties can decrypt trade details.
contract ConfidentialOTC is ZamaEthereumConfig {
    enum Status {
        Open,
        Filled,
        Cancelled
    }

    struct Order {
        address maker;
        address taker;
        euint64 price;
        euint64 amount;
        string tokenPair;
        bool isBuy;
        Status status;
        uint256 createdAt;
    }

    Order[] private _orders;

    event OrderCreated(uint256 indexed orderId, address indexed maker, string tokenPair, bool isBuy);
    event OrderFilled(uint256 indexed orderId, address indexed maker, address indexed taker);
    event OrderCancelled(uint256 indexed orderId);
    event AccessGranted(uint256 indexed orderId, address indexed viewer);

    error OrderNotOpen();
    error NotMaker();
    error MakerCannotFill();

    /// @notice Total number of orders created
    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    /// @notice Create an OTC order with encrypted price and amount
    function createOrder(
        externalEuint64 encPrice,
        bytes calldata priceProof,
        externalEuint64 encAmount,
        bytes calldata amountProof,
        bool isBuy,
        string calldata tokenPair
    ) external returns (uint256 orderId) {
        euint64 price = FHE.fromExternal(encPrice, priceProof);
        euint64 amount = FHE.fromExternal(encAmount, amountProof);

        // ACL: allow contract and maker to access encrypted values
        FHE.allowThis(price);
        FHE.allow(price, msg.sender);
        FHE.allowThis(amount);
        FHE.allow(amount, msg.sender);

        orderId = _orders.length;
        _orders.push(
            Order({
                maker: msg.sender,
                taker: address(0),
                price: price,
                amount: amount,
                tokenPair: tokenPair,
                isBuy: isBuy,
                status: Status.Open,
                createdAt: block.timestamp
            })
        );

        emit OrderCreated(orderId, msg.sender, tokenPair, isBuy);
    }

    /// @notice Fill an open order as the taker
    function fillOrder(uint256 orderId) external {
        Order storage order = _orders[orderId];
        if (order.status != Status.Open) revert OrderNotOpen();
        if (order.maker == msg.sender) revert MakerCannotFill();

        order.taker = msg.sender;
        order.status = Status.Filled;

        // Grant taker access to encrypted price and amount
        FHE.allow(order.price, msg.sender);
        FHE.allow(order.amount, msg.sender);

        emit OrderFilled(orderId, order.maker, msg.sender);
    }

    /// @notice Cancel an open order (maker only)
    function cancelOrder(uint256 orderId) external {
        Order storage order = _orders[orderId];
        if (order.status != Status.Open) revert OrderNotOpen();
        if (order.maker != msg.sender) revert NotMaker();

        order.status = Status.Cancelled;
        emit OrderCancelled(orderId);
    }

    /// @notice Maker grants a specific address permission to view encrypted fields
    function grantAccess(uint256 orderId, address viewer) external {
        Order storage order = _orders[orderId];
        if (order.maker != msg.sender) revert NotMaker();

        FHE.allow(order.price, viewer);
        FHE.allow(order.amount, viewer);

        emit AccessGranted(orderId, viewer);
    }

    /// @notice Get public fields of an order
    function getOrder(
        uint256 orderId
    )
        external
        view
        returns (address maker, address taker, string memory tokenPair, bool isBuy, Status status, uint256 createdAt)
    {
        Order storage order = _orders[orderId];
        return (order.maker, order.taker, order.tokenPair, order.isBuy, order.status, order.createdAt);
    }

    /// @notice Get encrypted price (only accessible by allowed addresses)
    function getPrice(uint256 orderId) external view returns (euint64) {
        return _orders[orderId].price;
    }

    /// @notice Get encrypted amount (only accessible by allowed addresses)
    function getAmount(uint256 orderId) external view returns (euint64) {
        return _orders[orderId].amount;
    }
}
