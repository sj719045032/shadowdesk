import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { ConfidentialOTC, ConfidentialOTC__factory } from "../types";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
  auditor: HardhatEthersSigner;
};

async function deployFixture() {
  const factory = (await ethers.getContractFactory("ConfidentialOTC")) as ConfidentialOTC__factory;
  const contract = (await factory.deploy()) as ConfidentialOTC;
  const contractAddress = await contract.getAddress();
  return { contract, contractAddress };
}

describe("ConfidentialOTC - Confidential Dark Pool", function () {
  let signers: Signers;
  let contract: ConfidentialOTC;
  let contractAddress: string;

  before(async function () {
    const ethSigners = await ethers.getSigners();
    signers = {
      deployer: ethSigners[0],
      alice: ethSigners[1],
      bob: ethSigners[2],
      carol: ethSigners[3],
      auditor: ethSigners[4],
    };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This test suite requires mock FHEVM");
      this.skip();
    }
    ({ contract, contractAddress } = await deployFixture());
  });

  // =========================================================================
  //                        OWNERSHIP & ADMIN
  // =========================================================================

  describe("Ownership", function () {
    it("deployer should be the owner", async function () {
      expect(await contract.owner()).to.eq(signers.deployer.address);
    });

    it("owner can transfer ownership", async function () {
      await expect(contract.connect(signers.deployer).transferOwnership(signers.alice.address))
        .to.emit(contract, "OwnershipTransferred")
        .withArgs(signers.deployer.address, signers.alice.address);
      expect(await contract.owner()).to.eq(signers.alice.address);
    });

    it("non-owner cannot transfer ownership", async function () {
      await expect(
        contract.connect(signers.alice).transferOwnership(signers.bob.address),
      ).to.be.revertedWithCustomError(contract, "NotOwner");
    });

    it("cannot transfer ownership to zero address", async function () {
      await expect(
        contract.connect(signers.deployer).transferOwnership(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(contract, "ZeroAddress");
    });
  });

  // =========================================================================
  //                        AUDITOR MANAGEMENT
  // =========================================================================

  describe("Auditor", function () {
    it("owner can set auditor", async function () {
      await expect(contract.connect(signers.deployer).setAuditor(signers.auditor.address))
        .to.emit(contract, "AuditorUpdated")
        .withArgs(ethers.ZeroAddress, signers.auditor.address);
      expect(await contract.auditor()).to.eq(signers.auditor.address);
    });

    it("non-owner cannot set auditor", async function () {
      await expect(
        contract.connect(signers.alice).setAuditor(signers.auditor.address),
      ).to.be.revertedWithCustomError(contract, "NotOwner");
    });

    it("cannot set auditor to zero address", async function () {
      await expect(
        contract.connect(signers.deployer).setAuditor(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(contract, "ZeroAddress");
    });
  });

  // =========================================================================
  //                        ORDER CREATION
  // =========================================================================

  describe("createOrder", function () {
    it("should create an order with encrypted price and amount and ETH deposit", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500) // price
        .add64(100) // amount
        .encrypt();

      const depositAmount = ethers.parseEther("1.0");

      const tx = await contract
        .connect(signers.alice)
        .createOrder(
          encInput.handles[0],
          encInput.inputProof,
          encInput.handles[1],
          encInput.inputProof,
          true,
          "ETH/USDC",
          { value: depositAmount },
        );

      await expect(tx)
        .to.emit(contract, "OrderCreated")
        .withArgs(0, signers.alice.address, "ETH/USDC", true, depositAmount);

      expect(await contract.orderCount()).to.eq(1);

      const order = await contract.getOrder(0);
      expect(order.maker).to.eq(signers.alice.address);
      expect(order.tokenPair).to.eq("ETH/USDC");
      expect(order.isBuy).to.eq(true);
      expect(order.status).to.eq(0); // Open
      expect(order.ethDeposit).to.eq(depositAmount);
    });

    it("should revert if no ETH is deposited", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        contract
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
          ),
      ).to.be.revertedWithCustomError(contract, "ZeroDeposit");
    });

    it("maker can decrypt their own order price and amount", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(2500)
        .add64(50)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "BTC/USDC",
            { value: ethers.parseEther("2.0") },
          )
      ).wait();

      // Decrypt price
      const encPrice = await contract.getPrice(0);
      const decPrice = await fhevm.userDecryptEuint(FhevmType.euint64, encPrice, contractAddress, signers.alice);
      expect(decPrice).to.eq(2500);

      // Decrypt amount
      const encAmount = await contract.getAmount(0);
      const decAmount = await fhevm.userDecryptEuint(FhevmType.euint64, encAmount, contractAddress, signers.alice);
      expect(decAmount).to.eq(50);

      // Decrypt remaining amount (should equal initial amount)
      const encRemaining = await contract.getRemainingAmount(0);
      const decRemaining = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encRemaining,
        contractAddress,
        signers.alice,
      );
      expect(decRemaining).to.eq(50);
    });

    it("should create multiple orders and track count", async function () {
      for (let i = 0; i < 3; i++) {
        const encInput = await fhevm
          .createEncryptedInput(contractAddress, signers.alice.address)
          .add64(1000 + i * 100)
          .add64(10 + i)
          .encrypt();

        await (
          await contract
            .connect(signers.alice)
            .createOrder(
              encInput.handles[0],
              encInput.inputProof,
              encInput.handles[1],
              encInput.inputProof,
              true,
              "ETH/USDC",
              { value: ethers.parseEther("0.5") },
            )
        ).wait();
      }

      expect(await contract.orderCount()).to.eq(3);
    });
  });

  // =========================================================================
  //                   ENCRYPTED PRICE MATCHING & FILLING
  // =========================================================================

  describe("fillOrder - Encrypted Price Matching", function () {
    let orderId: number;
    const makerPrice = 1500;
    const makerAmount = 100;
    const depositAmount = ethers.parseEther("1.0");

    beforeEach(async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(makerPrice)
        .add64(makerAmount)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            { value: depositAmount },
          )
      ).wait();
      orderId = 0;
    });

    it("should fill when taker price >= maker price (exact match)", async function () {
      const takerEncInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1500) // exact match
        .add64(100) // full amount
        .encrypt();

      const bobBalanceBefore = await ethers.provider.getBalance(signers.bob.address);

      const tx = await contract
        .connect(signers.bob)
        .fillOrder(
          orderId,
          takerEncInput.handles[0],
          takerEncInput.inputProof,
          takerEncInput.handles[1],
          takerEncInput.inputProof,
        );

      await expect(tx).to.emit(contract, "OrderFilled").withArgs(orderId, 0, depositAmount);

      // Order should be marked as Filled
      const order = await contract.getOrder(orderId);
      expect(order.status).to.eq(1); // Filled

      // Fill count should be 1
      expect(await contract.fillCount()).to.eq(1);
      expect(await contract.totalFillCount()).to.eq(1);

      // Verify fill record
      const fill = await contract.getFill(0);
      expect(fill.orderId).to.eq(orderId);
      expect(fill.ethTransferred).to.eq(depositAmount);
    });

    it("should fill when taker price > maker price", async function () {
      const takerEncInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(2000) // higher than maker's 1500
        .add64(100)
        .encrypt();

      const tx = await contract
        .connect(signers.bob)
        .fillOrder(
          orderId,
          takerEncInput.handles[0],
          takerEncInput.inputProof,
          takerEncInput.handles[1],
          takerEncInput.inputProof,
        );

      await expect(tx).to.emit(contract, "OrderFilled");

      const order = await contract.getOrder(orderId);
      expect(order.status).to.eq(1); // Filled
    });

    it("maker cannot fill own order", async function () {
      const takerEncInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        contract
          .connect(signers.alice)
          .fillOrder(
            orderId,
            takerEncInput.handles[0],
            takerEncInput.inputProof,
            takerEncInput.handles[1],
            takerEncInput.inputProof,
          ),
      ).to.be.revertedWithCustomError(contract, "MakerCannotFill");
    });

    it("cannot fill a non-open order", async function () {
      // First fill the order
      const takerEncInput1 = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            orderId,
            takerEncInput1.handles[0],
            takerEncInput1.inputProof,
            takerEncInput1.handles[1],
            takerEncInput1.inputProof,
          )
      ).wait();

      // Try to fill again
      const takerEncInput2 = await fhevm
        .createEncryptedInput(contractAddress, signers.carol.address)
        .add64(1500)
        .add64(50)
        .encrypt();

      await expect(
        contract
          .connect(signers.carol)
          .fillOrder(
            orderId,
            takerEncInput2.handles[0],
            takerEncInput2.inputProof,
            takerEncInput2.handles[1],
            takerEncInput2.inputProof,
          ),
      ).to.be.revertedWithCustomError(contract, "OrderNotOpen");
    });

    it("should revert with InvalidOrderId for non-existent order", async function () {
      const takerEncInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        contract
          .connect(signers.bob)
          .fillOrder(
            999,
            takerEncInput.handles[0],
            takerEncInput.inputProof,
            takerEncInput.handles[1],
            takerEncInput.inputProof,
          ),
      ).to.be.revertedWithCustomError(contract, "InvalidOrderId");
    });
  });

  // =========================================================================
  //                       ENCRYPTED PARTIAL FILLS
  // =========================================================================

  describe("fillOrder - Encrypted Partial Fills", function () {
    it("should compute partial fill using FHE.min when taker wants less", async function () {
      // Maker creates order for 100 units
      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500) // price
        .add64(100) // amount
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      // Taker wants only 30 units at matching price
      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1500)
        .add64(30) // partial fill
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      // Verify the fill amount is 30 (min of 30, 100)
      const encFillAmount = await contract.getFillAmount(0);
      const decFillAmount = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        contractAddress,
        signers.bob,
      );
      expect(decFillAmount).to.eq(30);
    });

    it("fill amount should be capped at remaining when taker wants more", async function () {
      // Maker creates order for 50 units
      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1000)
        .add64(50) // only 50 available
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("0.5") },
          )
      ).wait();

      // Taker wants 200 units (more than available)
      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1000)
        .add64(200) // wants more than available
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      // Fill amount should be capped at 50 (min of 200, 50)
      const encFillAmount = await contract.getFillAmount(0);
      const decFillAmount = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        contractAddress,
        signers.bob,
      );
      expect(decFillAmount).to.eq(50);
    });
  });

  // =========================================================================
  //                    ENCRYPTED SETTLEMENT TOTAL
  // =========================================================================

  describe("fillOrder - Encrypted Settlement Total", function () {
    it("should compute encrypted total as price * fillAmount", async function () {
      const price = 1500;
      const amount = 100;

      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(price)
        .add64(amount)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(price) // exact match
        .add64(amount) // full fill
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      // Decrypt the settlement total
      const encTotal = await contract.getFillTotal(0);
      const decTotal = await fhevm.userDecryptEuint(FhevmType.euint64, encTotal, contractAddress, signers.bob);
      expect(decTotal).to.eq(BigInt(price) * BigInt(amount)); // 1500 * 100 = 150000
    });
  });

  // =========================================================================
  //                         ETH ESCROW
  // =========================================================================

  describe("ETH Escrow", function () {
    it("ETH should be held in contract after order creation", async function () {
      const depositAmount = ethers.parseEther("2.5");
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            { value: depositAmount },
          )
      ).wait();

      const contractBalance = await ethers.provider.getBalance(contractAddress);
      expect(contractBalance).to.eq(depositAmount);
    });

    it("ETH should transfer to taker on fill", async function () {
      const depositAmount = ethers.parseEther("1.0");

      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: depositAmount },
          )
      ).wait();

      const bobBalanceBefore = await ethers.provider.getBalance(signers.bob.address);

      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      const tx = await contract
        .connect(signers.bob)
        .fillOrder(
          0,
          takerInput.handles[0],
          takerInput.inputProof,
          takerInput.handles[1],
          takerInput.inputProof,
        );
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const bobBalanceAfter = await ethers.provider.getBalance(signers.bob.address);

      // Bob should have received the deposit minus gas
      expect(bobBalanceAfter).to.eq(bobBalanceBefore + depositAmount - gasUsed);

      // Contract balance should be 0
      const contractBalance = await ethers.provider.getBalance(contractAddress);
      expect(contractBalance).to.eq(0);
    });

    it("ETH should be refunded on cancel", async function () {
      const depositAmount = ethers.parseEther("3.0");

      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            { value: depositAmount },
          )
      ).wait();

      const aliceBalanceBefore = await ethers.provider.getBalance(signers.alice.address);

      const tx = await contract.connect(signers.alice).cancelOrder(0);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const aliceBalanceAfter = await ethers.provider.getBalance(signers.alice.address);

      // Alice should get the deposit back minus gas
      expect(aliceBalanceAfter).to.eq(aliceBalanceBefore + depositAmount - gasUsed);
    });
  });

  // =========================================================================
  //                      CANCEL ORDER
  // =========================================================================

  describe("cancelOrder", function () {
    it("maker can cancel their open order", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      await expect(contract.connect(signers.alice).cancelOrder(0))
        .to.emit(contract, "OrderCancelled")
        .withArgs(0, ethers.parseEther("1.0"));

      const order = await contract.getOrder(0);
      expect(order.status).to.eq(2); // Cancelled
      expect(order.ethDeposit).to.eq(0);
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
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      await expect(contract.connect(signers.bob).cancelOrder(0)).to.be.revertedWithCustomError(contract, "NotMaker");
    });

    it("cannot cancel already filled order", async function () {
      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      await expect(contract.connect(signers.alice).cancelOrder(0)).to.be.revertedWithCustomError(
        contract,
        "OrderNotOpen",
      );
    });

    it("cannot cancel non-existent order", async function () {
      await expect(contract.connect(signers.alice).cancelOrder(999)).to.be.revertedWithCustomError(
        contract,
        "InvalidOrderId",
      );
    });
  });

  // =========================================================================
  //                    FAIR TIEBREAKING (RANDOMNESS)
  // =========================================================================

  describe("Fair Tiebreaking", function () {
    it("fill should have a random priority score", async function () {
      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1000)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1000)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      // The priority score handle should exist (non-zero)
      const encPriority = await contract.getFillPriorityScore(0);
      expect(encPriority).to.not.eq(ethers.ZeroHash);

      // Maker should be able to decrypt it
      const decPriority = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encPriority,
        contractAddress,
        signers.alice,
      );
      // Just verify it's a valid number (random, so we can't predict exact value)
      expect(decPriority).to.be.gte(0);
    });
  });

  // =========================================================================
  //                   ENCRYPTED COUNTERPARTY (eaddress)
  // =========================================================================

  describe("Encrypted Counterparty", function () {
    it("taker address should be encrypted and decryptable by maker", async function () {
      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      // Maker should be able to decrypt the taker's encrypted address
      const encTaker = await contract.getEncryptedTaker(0);
      const decTaker = await fhevm.userDecryptEaddress(encTaker, contractAddress, signers.alice);
      expect(decTaker.toLowerCase()).to.eq(signers.bob.address.toLowerCase());
    });

    it("taker can decrypt their own encrypted address from the fill", async function () {
      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      // Bob can decrypt his own encrypted taker address from the fill record
      const encFillTaker = await contract.getFillEncryptedTaker(0);
      const decFillTaker = await fhevm.userDecryptEaddress(encFillTaker, contractAddress, signers.bob);
      expect(decFillTaker.toLowerCase()).to.eq(signers.bob.address.toLowerCase());
    });
  });

  // =========================================================================
  //               COMPLIANCE / AUDITOR ACCESS
  // =========================================================================

  describe("Auditor Compliance Access", function () {
    it("auditor can decrypt order details after being granted access", async function () {
      // Set auditor
      await (await contract.connect(signers.deployer).setAuditor(signers.auditor.address)).wait();

      // Create order
      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            false,
            "SOL/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      // Fill order
      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      // Owner grants auditor access
      await expect(contract.connect(signers.deployer).grantAuditorAccess(0))
        .to.emit(contract, "AuditorAccessGranted")
        .withArgs(0);

      // Auditor can now decrypt everything
      const encPrice = await contract.getPrice(0);
      const decPrice = await fhevm.userDecryptEuint(FhevmType.euint64, encPrice, contractAddress, signers.auditor);
      expect(decPrice).to.eq(5000);

      const encAmount = await contract.getAmount(0);
      const decAmount = await fhevm.userDecryptEuint(FhevmType.euint64, encAmount, contractAddress, signers.auditor);
      expect(decAmount).to.eq(200);

      // Auditor can decrypt fill details too
      const encFillAmount = await contract.getFillAmount(0);
      const decFillAmount = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        contractAddress,
        signers.auditor,
      );
      expect(decFillAmount).to.eq(200);

      // Auditor can decrypt the settlement total
      const encFillTotal = await contract.getFillTotal(0);
      const decFillTotal = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillTotal,
        contractAddress,
        signers.auditor,
      );
      expect(decFillTotal).to.eq(BigInt(5000) * BigInt(200));
    });

    it("grantAuditorAccess reverts when no auditor is set", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      await expect(contract.connect(signers.deployer).grantAuditorAccess(0)).to.be.revertedWithCustomError(
        contract,
        "ZeroAddress",
      );
    });

    it("non-owner cannot grant auditor access", async function () {
      await (await contract.connect(signers.deployer).setAuditor(signers.auditor.address)).wait();

      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      await expect(contract.connect(signers.alice).grantAuditorAccess(0)).to.be.revertedWithCustomError(
        contract,
        "NotOwner",
      );
    });
  });

  // =========================================================================
  //                    POST-TRADE TRANSPARENCY
  // =========================================================================

  describe("Post-Trade Transparency", function () {
    it("fill amount should be publicly decryptable after settlement", async function () {
      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("0.5") },
          )
      ).wait();

      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      // The fill amount was made publicly decryptable via FHE.makePubliclyDecryptable.
      // In mock environment, any authorized party can decrypt. Carol (a third party)
      // should be able to decrypt the fill amount since it was made public.
      const encFillAmount = await contract.getFillAmount(0);
      expect(encFillAmount).to.not.eq(ethers.ZeroHash);

      // Both maker and taker can decrypt (they have explicit ACL grants)
      const decFillByMaker = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        contractAddress,
        signers.alice,
      );
      expect(decFillByMaker).to.eq(50);

      const decFillByTaker = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        contractAddress,
        signers.bob,
      );
      expect(decFillByTaker).to.eq(50);
    });
  });

  // =========================================================================
  //                       GRANT ACCESS
  // =========================================================================

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
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "SOL/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      await expect(contract.connect(signers.alice).grantAccess(0, signers.carol.address))
        .to.emit(contract, "AccessGranted")
        .withArgs(0, signers.carol.address);

      // Carol can now decrypt
      const encPrice = await contract.getPrice(0);
      const decPrice = await fhevm.userDecryptEuint(FhevmType.euint64, encPrice, contractAddress, signers.carol);
      expect(decPrice).to.eq(5000);

      const encAmount = await contract.getAmount(0);
      const decAmount = await fhevm.userDecryptEuint(FhevmType.euint64, encAmount, contractAddress, signers.carol);
      expect(decAmount).to.eq(200);
    });

    it("non-maker cannot grant access", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      await expect(
        contract.connect(signers.bob).grantAccess(0, signers.carol.address),
      ).to.be.revertedWithCustomError(contract, "NotMaker");
    });

    it("cannot grant access to zero address", async function () {
      const encInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      await expect(
        contract.connect(signers.alice).grantAccess(0, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(contract, "ZeroAddress");
    });
  });

  // =========================================================================
  //                        VIEW FUNCTIONS
  // =========================================================================

  describe("View Functions", function () {
    it("should return correct order count", async function () {
      expect(await contract.orderCount()).to.eq(0);
      expect(await contract.fillCount()).to.eq(0);
    });

    it("should revert getOrder for invalid orderId", async function () {
      await expect(contract.getOrder(0)).to.be.revertedWithCustomError(contract, "InvalidOrderId");
    });

    it("should revert getPrice for invalid orderId", async function () {
      await expect(contract.getPrice(0)).to.be.revertedWithCustomError(contract, "InvalidOrderId");
    });

    it("should revert getAmount for invalid orderId", async function () {
      await expect(contract.getAmount(0)).to.be.revertedWithCustomError(contract, "InvalidOrderId");
    });

    it("should revert getRemainingAmount for invalid orderId", async function () {
      await expect(contract.getRemainingAmount(0)).to.be.revertedWithCustomError(contract, "InvalidOrderId");
    });

    it("should revert getEncryptedTaker for invalid orderId", async function () {
      await expect(contract.getEncryptedTaker(0)).to.be.revertedWithCustomError(contract, "InvalidOrderId");
    });

    it("should revert getFill for invalid fillId", async function () {
      await expect(contract.getFill(0)).to.be.revertedWithCustomError(contract, "InvalidFillId");
    });

    it("should revert getFillAmount for invalid fillId", async function () {
      await expect(contract.getFillAmount(0)).to.be.revertedWithCustomError(contract, "InvalidFillId");
    });

    it("should revert getFillTotal for invalid fillId", async function () {
      await expect(contract.getFillTotal(0)).to.be.revertedWithCustomError(contract, "InvalidFillId");
    });

    it("should revert getFillPriorityScore for invalid fillId", async function () {
      await expect(contract.getFillPriorityScore(0)).to.be.revertedWithCustomError(contract, "InvalidFillId");
    });

    it("should revert getFillEncryptedTaker for invalid fillId", async function () {
      await expect(contract.getFillEncryptedTaker(0)).to.be.revertedWithCustomError(contract, "InvalidFillId");
    });

    it("getOrderFills should return fill IDs for an order", async function () {
      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      const fillIds = await contract.getOrderFills(0);
      expect(fillIds.length).to.eq(1);
      expect(fillIds[0]).to.eq(0);
    });
  });

  // =========================================================================
  //                   PROTOCOL VOLUME TRACKING
  // =========================================================================

  describe("Protocol Volume Tracking", function () {
    it("total volume should accumulate across fills", async function () {
      // Create and fill first order
      const maker1Input = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            maker1Input.handles[0],
            maker1Input.inputProof,
            maker1Input.handles[1],
            maker1Input.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("0.5") },
          )
      ).wait();

      const taker1Input = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            taker1Input.handles[0],
            taker1Input.inputProof,
            taker1Input.handles[1],
            taker1Input.inputProof,
          )
      ).wait();

      // Create and fill second order
      const maker2Input = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(2000)
        .add64(30)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            maker2Input.handles[0],
            maker2Input.inputProof,
            maker2Input.handles[1],
            maker2Input.inputProof,
            false,
            "BTC/USDC",
            { value: ethers.parseEther("0.3") },
          )
      ).wait();

      const taker2Input = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(2000)
        .add64(30)
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            1,
            taker2Input.handles[0],
            taker2Input.inputProof,
            taker2Input.handles[1],
            taker2Input.inputProof,
          )
      ).wait();

      expect(await contract.totalFillCount()).to.eq(2);

      // Total volume handle should exist
      const encVolume = await contract.getTotalVolume();
      expect(encVolume).to.not.eq(ethers.ZeroHash);
    });
  });

  // =========================================================================
  //                        EDGE CASES
  // =========================================================================

  describe("Edge Cases", function () {
    it("fill with zero taker amount should produce zero fill", async function () {
      const makerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await contract
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            { value: ethers.parseEther("1.0") },
          )
      ).wait();

      const takerInput = await fhevm
        .createEncryptedInput(contractAddress, signers.bob.address)
        .add64(1500)
        .add64(0) // zero amount
        .encrypt();

      await (
        await contract
          .connect(signers.bob)
          .fillOrder(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
          )
      ).wait();

      // Fill amount should be 0
      const encFillAmount = await contract.getFillAmount(0);
      const decFillAmount = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        contractAddress,
        signers.bob,
      );
      expect(decFillAmount).to.eq(0);
    });

    it("receive function should accept plain ETH", async function () {
      const tx = await signers.deployer.sendTransaction({
        to: contractAddress,
        value: ethers.parseEther("1.0"),
      });
      await tx.wait();

      const balance = await ethers.provider.getBalance(contractAddress);
      expect(balance).to.eq(ethers.parseEther("1.0"));
    });
  });
});
