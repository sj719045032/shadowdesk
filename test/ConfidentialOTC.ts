import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { ConfidentialOTC, ConfidentialOTC__factory } from "../types";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
};

async function deployFixture() {
  const factory = (await ethers.getContractFactory("ConfidentialOTC")) as ConfidentialOTC__factory;
  const contract = (await factory.deploy()) as ConfidentialOTC;
  const contractAddress = await contract.getAddress();
  return { contract, contractAddress };
}

describe("ConfidentialOTC", function () {
  let signers: Signers;
  let contract: ConfidentialOTC;
  let contractAddress: string;

  before(async function () {
    const ethSigners = await ethers.getSigners();
    signers = { deployer: ethSigners[0], alice: ethSigners[1], bob: ethSigners[2] };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This test suite requires mock FHEVM");
      this.skip();
    }
    ({ contract, contractAddress } = await deployFixture());
  });

  describe("createOrder", function () {
    it("should create an order with encrypted price and amount", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500) // price
        .add64(100) // amount
        .encrypt();

      const tx = await contract
        .connect(signers.alice)
        .createOrder(encInput.handles[0], encInput.inputProof, encInput.handles[1], encInput.inputProof, true, "ETH/USDC");
      await tx.wait();

      expect(await contract.orderCount()).to.eq(1);

      const order = await contract.getOrder(0);
      expect(order.maker).to.eq(signers.alice.address);
      expect(order.taker).to.eq(ethers.ZeroAddress);
      expect(order.tokenPair).to.eq("ETH/USDC");
      expect(order.isBuy).to.eq(true);
      expect(order.status).to.eq(0); // Open
    });

    it("maker should be able to decrypt their own order", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(2500)
        .add64(50)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(encInput.handles[0], encInput.inputProof, encInput.handles[1], encInput.inputProof, false, "BTC/USDC")
      ).wait();

      const encPrice = await contract.getPrice(0);
      const decPrice = await fhevm.userDecryptEuint(FhevmType.euint64, encPrice, contractAddress, signers.alice);
      expect(decPrice).to.eq(2500);

      const encAmount = await contract.getAmount(0);
      const decAmount = await fhevm.userDecryptEuint(FhevmType.euint64, encAmount, contractAddress, signers.alice);
      expect(decAmount).to.eq(50);
    });
  });

  describe("fillOrder", function () {
    it("should allow taker to fill an open order", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(encInput.handles[0], encInput.inputProof, encInput.handles[1], encInput.inputProof, true, "ETH/USDC")
      ).wait();

      await (await contract.connect(signers.bob).fillOrder(0)).wait();

      const order = await contract.getOrder(0);
      expect(order.taker).to.eq(signers.bob.address);
      expect(order.status).to.eq(1); // Filled
    });

    it("taker should be able to decrypt filled order details", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(3000)
        .add64(10)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(encInput.handles[0], encInput.inputProof, encInput.handles[1], encInput.inputProof, true, "ETH/USDC")
      ).wait();

      await (await contract.connect(signers.bob).fillOrder(0)).wait();

      const encPrice = await contract.getPrice(0);
      const decPrice = await fhevm.userDecryptEuint(FhevmType.euint64, encPrice, contractAddress, signers.bob);
      expect(decPrice).to.eq(3000);
    });

    it("maker cannot fill own order", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(encInput.handles[0], encInput.inputProof, encInput.handles[1], encInput.inputProof, true, "ETH/USDC")
      ).wait();

      await expect(contract.connect(signers.alice).fillOrder(0)).to.be.revertedWithCustomError(
        contract,
        "MakerCannotFill",
      );
    });

    it("cannot fill a non-open order", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(encInput.handles[0], encInput.inputProof, encInput.handles[1], encInput.inputProof, true, "ETH/USDC")
      ).wait();

      await (await contract.connect(signers.bob).fillOrder(0)).wait();
      await expect(contract.connect(signers.deployer).fillOrder(0)).to.be.revertedWithCustomError(
        contract,
        "OrderNotOpen",
      );
    });
  });

  describe("cancelOrder", function () {
    it("maker can cancel their order", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(encInput.handles[0], encInput.inputProof, encInput.handles[1], encInput.inputProof, true, "ETH/USDC")
      ).wait();

      await (await contract.connect(signers.alice).cancelOrder(0)).wait();
      const order = await contract.getOrder(0);
      expect(order.status).to.eq(2); // Cancelled
    });

    it("non-maker cannot cancel order", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(encInput.handles[0], encInput.inputProof, encInput.handles[1], encInput.inputProof, true, "ETH/USDC")
      ).wait();

      await expect(contract.connect(signers.bob).cancelOrder(0)).to.be.revertedWithCustomError(contract, "NotMaker");
    });
  });

  describe("grantAccess", function () {
    it("maker can grant view access to third party", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(encInput.handles[0], encInput.inputProof, encInput.handles[1], encInput.inputProof, false, "SOL/USDC")
      ).wait();

      await (await contract.connect(signers.alice).grantAccess(0, signers.bob.address)).wait();

      const encPrice = await contract.getPrice(0);
      const decPrice = await fhevm.userDecryptEuint(FhevmType.euint64, encPrice, contractAddress, signers.bob);
      expect(decPrice).to.eq(5000);
    });
  });
});
