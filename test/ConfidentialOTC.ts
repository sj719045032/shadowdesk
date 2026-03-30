import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import {
  ConfidentialOTC,
  ConfidentialOTC__factory,
  ConfidentialWETH,
  ConfidentialWETH__factory,
  ConfidentialUSDC,
  ConfidentialUSDC__factory,
  MockERC20,
  MockERC20__factory,
} from "../types";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
  auditor: HardhatEthersSigner;
};

// Max uint48 for operator expiry (never expires)
const MAX_UINT48 = (1n << 48n) - 1n;

async function deployFixture() {
  // Deploy mock ERC20 token (USDC with 6 decimals) as underlying for cUSDC
  const tokenFactory = (await ethers.getContractFactory("MockERC20")) as MockERC20__factory;
  const mockUsdc = (await tokenFactory.deploy("Mock USDC", "USDC", 6)) as MockERC20;
  const mockUsdcAddress = await mockUsdc.getAddress();

  // Deploy ConfidentialWETH (ERC7984-based)
  const cWethFactory = (await ethers.getContractFactory("ConfidentialWETH")) as ConfidentialWETH__factory;
  const cWeth = (await cWethFactory.deploy()) as ConfidentialWETH;
  const cWethAddress = await cWeth.getAddress();

  // Deploy ConfidentialUSDC with mock USDC as underlying (ERC7984ERC20Wrapper-based)
  const cUsdcFactory = (await ethers.getContractFactory("ConfidentialUSDC")) as ConfidentialUSDC__factory;
  const cUsdc = (await cUsdcFactory.deploy(mockUsdcAddress)) as ConfidentialUSDC;
  const cUsdcAddress = await cUsdc.getAddress();

  // Deploy ConfidentialOTC with cWETH and cUSDC
  // skipVerification=true for Hardhat mock mode (KMS not available)
  const otcFactory = (await ethers.getContractFactory("ConfidentialOTC")) as ConfidentialOTC__factory;
  const otc = (await otcFactory.deploy(cWethAddress, cUsdcAddress, true)) as ConfidentialOTC;
  const otcAddress = await otc.getAddress();

  return { otc, otcAddress, cWeth, cWethAddress, cUsdc, cUsdcAddress, mockUsdc, mockUsdcAddress };
}

// =========================================================================
//                    CONFIDENTIAL WETH TESTS
// =========================================================================

describe("ConfidentialWETH - ERC7984 Wrap/Unwrap", function () {
  let signers: Signers;
  let cWeth: ConfidentialWETH;
  let cWethAddress: string;

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
    ({ cWeth, cWethAddress } = await deployFixture());
  });

  it("should wrap ETH into cWETH", async function () {
    const wrapAmount = ethers.parseEther("1.0");
    await expect(cWeth.connect(signers.alice).wrap({ value: wrapAmount }))
      .to.emit(cWeth, "Wrap")
      .withArgs(signers.alice.address, wrapAmount);

    // Contract should hold the ETH
    const contractBalance = await ethers.provider.getBalance(cWethAddress);
    expect(contractBalance).to.eq(wrapAmount);
  });

  it("should revert wrap with zero ETH", async function () {
    await expect(cWeth.connect(signers.alice).wrap({ value: 0 })).to.be.revertedWith("Zero amount");
  });

  it("should request unwrap of cWETH", async function () {
    const wrapAmount = ethers.parseEther("2.0");
    await (await cWeth.connect(signers.alice).wrap({ value: wrapAmount })).wait();

    const unwrapAmount = ethers.parseEther("1.0");
    // unwrap now emits UnwrapRequested (two-phase: needs finalizeUnwrap for ETH transfer)
    await expect(cWeth.connect(signers.alice).unwrap(unwrapAmount))
      .to.emit(cWeth, "UnwrapRequested");
  });

  it("should have correct name, symbol, decimals", async function () {
    expect(await cWeth.name()).to.eq("Confidential Wrapped ETH");
    expect(await cWeth.symbol()).to.eq("cWETH");
    expect(await cWeth.decimals()).to.eq(18);
  });

  it("should support setOperator and isOperator (ERC7984)", async function () {
    // Alice sets Bob as operator
    await (await cWeth.connect(signers.alice).setOperator(signers.bob.address, MAX_UINT48)).wait();
    expect(await cWeth.isOperator(signers.alice.address, signers.bob.address)).to.eq(true);
    // Carol is not an operator for Alice
    expect(await cWeth.isOperator(signers.alice.address, signers.carol.address)).to.eq(false);
  });

  it("should support depositFrom with operator authorization", async function () {
    const wrapAmount = ethers.parseEther("1.0");
    await (await cWeth.connect(signers.alice).wrap({ value: wrapAmount })).wait();

    // Alice sets Bob as operator
    await (await cWeth.connect(signers.alice).setOperator(signers.bob.address, MAX_UINT48)).wait();

    // Bob can depositFrom Alice to Carol
    const transferAmount = ethers.parseEther("0.5");
    await expect(
      cWeth.connect(signers.bob).depositFrom(signers.alice.address, signers.carol.address, transferAmount),
    ).to.not.be.reverted;
  });

  it("should revert depositFrom without operator authorization", async function () {
    const wrapAmount = ethers.parseEther("1.0");
    await (await cWeth.connect(signers.alice).wrap({ value: wrapAmount })).wait();

    // Bob is NOT an operator for Alice
    await expect(
      cWeth.connect(signers.bob).depositFrom(signers.alice.address, signers.carol.address, ethers.parseEther("0.5")),
    ).to.be.revertedWithCustomError(cWeth, "ERC7984UnauthorizedSpender");
  });

  it("should accumulate balance on multiple wraps", async function () {
    await (await cWeth.connect(signers.alice).wrap({ value: ethers.parseEther("1.0") })).wait();
    await (await cWeth.connect(signers.alice).wrap({ value: ethers.parseEther("2.0") })).wait();

    const contractBalance = await ethers.provider.getBalance(cWethAddress);
    expect(contractBalance).to.eq(ethers.parseEther("3.0"));
  });
});

// =========================================================================
//                    CONFIDENTIAL USDC TESTS
// =========================================================================

describe("ConfidentialUSDC - ERC7984 ERC20 Wrapper", function () {
  let signers: Signers;
  let cUsdc: ConfidentialUSDC;
  let cUsdcAddress: string;
  let mockUsdc: MockERC20;
  let mockUsdcAddress: string;

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
    ({ cUsdc, cUsdcAddress, mockUsdc, mockUsdcAddress } = await deployFixture());
  });

  // Helper: mint underlying USDC and approve cUSDC wrapper contract
  async function mintAndApproveUnderlying(signer: HardhatEthersSigner, amount: bigint) {
    await (await mockUsdc.mint(signer.address, amount)).wait();
    await (await mockUsdc.connect(signer).approve(cUsdcAddress, amount)).wait();
  }

  it("should wrap USDC into cUSDC via ERC7984ERC20Wrapper.wrap", async function () {
    const wrapAmount = 1000000n; // 1 USDC
    await mintAndApproveUnderlying(signers.alice, wrapAmount);

    // ERC7984ERC20Wrapper.wrap(to, amount) takes a destination address
    await (await cUsdc.connect(signers.alice).wrap(signers.alice.address, wrapAmount)).wait();

    // Contract should hold the underlying USDC
    const contractBalance = await mockUsdc.balanceOf(cUsdcAddress);
    expect(contractBalance).to.eq(wrapAmount);
  });

  it("should revert wrap without underlying approval", async function () {
    await (await mockUsdc.mint(signers.alice.address, 1000000n)).wait();
    // No approval to cUSDC wrapper
    await expect(cUsdc.connect(signers.alice).wrap(signers.alice.address, 1000000n)).to.be.reverted;
  });

  it("should have correct name, symbol, decimals", async function () {
    expect(await cUsdc.name()).to.eq("Confidential USDC");
    expect(await cUsdc.symbol()).to.eq("cUSDC");
    expect(await cUsdc.decimals()).to.eq(6);
  });

  it("should set underlying correctly", async function () {
    expect(await cUsdc.underlying()).to.eq(mockUsdcAddress);
  });

  it("should support setOperator and isOperator (ERC7984)", async function () {
    // Alice sets Bob as operator
    await (await cUsdc.connect(signers.alice).setOperator(signers.bob.address, MAX_UINT48)).wait();
    expect(await cUsdc.isOperator(signers.alice.address, signers.bob.address)).to.eq(true);
    expect(await cUsdc.isOperator(signers.alice.address, signers.carol.address)).to.eq(false);
  });

  it("should support depositFrom with operator authorization", async function () {
    const wrapAmount = 1000000n;
    await mintAndApproveUnderlying(signers.alice, wrapAmount);
    await (await cUsdc.connect(signers.alice).wrap(signers.alice.address, wrapAmount)).wait();

    // Alice sets Bob as operator
    await (await cUsdc.connect(signers.alice).setOperator(signers.bob.address, MAX_UINT48)).wait();

    // Bob can depositFrom Alice to Carol
    await expect(
      cUsdc.connect(signers.bob).depositFrom(signers.alice.address, signers.carol.address, 500000n),
    ).to.not.be.reverted;
  });

  it("should revert depositFrom without operator authorization", async function () {
    const wrapAmount = 1000000n;
    await mintAndApproveUnderlying(signers.alice, wrapAmount);
    await (await cUsdc.connect(signers.alice).wrap(signers.alice.address, wrapAmount)).wait();

    // Bob is NOT an operator for Alice
    await expect(
      cUsdc.connect(signers.bob).depositFrom(signers.alice.address, signers.carol.address, 500000n),
    ).to.be.revertedWithCustomError(cUsdc, "ERC7984UnauthorizedSpender");
  });

  it("should report rate correctly", async function () {
    // MockERC20 has 6 decimals, same as ERC7984 default max, so rate should be 1
    expect(await cUsdc.rate()).to.eq(1);
  });
});

// =========================================================================
//                    CONFIDENTIAL OTC TESTS
// =========================================================================

describe("ConfidentialOTC - Confidential Dark Pool (cWETH/cUSDC Swaps)", function () {
  let signers: Signers;
  let otc: ConfidentialOTC;
  let otcAddress: string;
  let cWeth: ConfidentialWETH;
  let cWethAddress: string;
  let cUsdc: ConfidentialUSDC;
  let cUsdcAddress: string;
  let mockUsdc: MockERC20;
  let mockUsdcAddress: string;

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
    ({ otc, otcAddress, cWeth, cWethAddress, cUsdc, cUsdcAddress, mockUsdc, mockUsdcAddress } =
      await deployFixture());
  });

  // Helper: wrap ETH -> cWETH and set OTC as operator (ERC7984 pattern)
  async function wrapEthAndApprove(signer: HardhatEthersSigner, ethAmount: bigint) {
    await (await cWeth.connect(signer).wrap({ value: ethAmount })).wait();
    // Set OTC as operator for this signer (idempotent - safe to call multiple times)
    await (await cWeth.connect(signer).setOperator(otcAddress, MAX_UINT48)).wait();
  }

  // Helper: mint underlying USDC, wrap to cUSDC, and set OTC as operator (ERC7984 pattern)
  async function wrapUsdcAndApprove(signer: HardhatEthersSigner, amount: bigint) {
    await (await mockUsdc.mint(signer.address, amount)).wait();
    await (await mockUsdc.connect(signer).approve(cUsdcAddress, amount)).wait();
    // ERC7984ERC20Wrapper.wrap(to, amount) takes a destination address
    await (await cUsdc.connect(signer).wrap(signer.address, amount)).wait();
    // Set OTC as operator for this signer (idempotent - safe to call multiple times)
    await (await cUsdc.connect(signer).setOperator(otcAddress, MAX_UINT48)).wait();
  }

  // Helper: settle a pending fill (two-phase settlement)
  // In mock mode, we pass the decrypted values directly since KMS is not available.
  // On Sepolia/mainnet, the KMS provides decryption proofs verified by checkSignatures.
  async function settleWithValues(
    caller: HardhatEthersSigner,
    pendingFillId: number,
    priceMatched: boolean,
    fillAmount: number,
  ) {
    return otc.connect(caller).settleFill(pendingFillId, priceMatched, fillAmount, [], "0x", "0x");
  }

  // =========================================================================
  //                        OWNERSHIP & ADMIN
  // =========================================================================

  describe("Ownership", function () {
    it("deployer should be the owner", async function () {
      expect(await otc.owner()).to.eq(signers.deployer.address);
    });

    it("owner can transfer ownership", async function () {
      await expect(otc.connect(signers.deployer).transferOwnership(signers.alice.address))
        .to.emit(otc, "OwnershipTransferred")
        .withArgs(signers.deployer.address, signers.alice.address);
      expect(await otc.owner()).to.eq(signers.alice.address);
    });

    it("non-owner cannot transfer ownership", async function () {
      await expect(
        otc.connect(signers.alice).transferOwnership(signers.bob.address),
      ).to.be.revertedWithCustomError(otc, "NotOwner");
    });

    it("cannot transfer ownership to zero address", async function () {
      await expect(
        otc.connect(signers.deployer).transferOwnership(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(otc, "ZeroAddress");
    });
  });

  // =========================================================================
  //                        AUDITOR MANAGEMENT
  // =========================================================================

  describe("Auditor", function () {
    it("owner can set auditor", async function () {
      await expect(otc.connect(signers.deployer).setAuditor(signers.auditor.address))
        .to.emit(otc, "AuditorUpdated")
        .withArgs(ethers.ZeroAddress, signers.auditor.address);
      expect(await otc.auditor()).to.eq(signers.auditor.address);
    });

    it("non-owner cannot set auditor", async function () {
      await expect(
        otc.connect(signers.alice).setAuditor(signers.auditor.address),
      ).to.be.revertedWithCustomError(otc, "NotOwner");
    });

    it("cannot set auditor to zero address", async function () {
      await expect(
        otc.connect(signers.deployer).setAuditor(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(otc, "ZeroAddress");
    });
  });

  // =========================================================================
  //                        SELL ORDER CREATION (cWETH deposit)
  // =========================================================================

  describe("createOrder - SELL (cWETH deposit)", function () {
    it("should create a SELL order with cWETH deposit", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500) // price
        .add64(100) // amount
        .encrypt();

      const tx = await otc
        .connect(signers.alice)
        .createOrder(
          encInput.handles[0],
          encInput.inputProof,
          encInput.handles[1],
          encInput.inputProof,
          false, // SELL
          "ETH/USDC",
          baseDeposit, // cWETH deposit
          0, // no cUSDC deposit for SELL
        );

      await expect(tx)
        .to.emit(otc, "OrderCreated")
        .withArgs(0, signers.alice.address, "ETH/USDC", false, baseDeposit, 0);

      expect(await otc.orderCount()).to.eq(1);

      const order = await otc.getOrder(0);
      expect(order.maker).to.eq(signers.alice.address);
      expect(order.tokenPair).to.eq("ETH/USDC");
      expect(order.isBuy).to.eq(false);
      expect(order.status).to.eq(0); // Open
      expect(order.baseDeposit).to.eq(baseDeposit);
      expect(order.quoteDeposit).to.eq(0);
      expect(order.baseRemaining).to.eq(baseDeposit);
      expect(order.quoteRemaining).to.eq(0);
    });

    it("should revert SELL order with zero base deposit", async function () {
      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            0, // zero base deposit
            0,
          ),
      ).to.be.revertedWithCustomError(otc, "ZeroDeposit");
    });

    it("should revert SELL order if quote deposit is non-zero", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            1000000n, // non-zero quote deposit for SELL = invalid
          ),
      ).to.be.revertedWithCustomError(otc, "InvalidDepositType");
    });
  });

  // =========================================================================
  //                        BUY ORDER CREATION (cUSDC deposit)
  // =========================================================================

  describe("createOrder - BUY (cUSDC deposit)", function () {
    it("should create a BUY order with cUSDC deposit", async function () {
      const quoteDeposit = 1000000n; // 1 USDC
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500) // price
        .add64(100) // amount
        .encrypt();

      const tx = await otc
        .connect(signers.alice)
        .createOrder(
          encInput.handles[0],
          encInput.inputProof,
          encInput.handles[1],
          encInput.inputProof,
          true, // BUY
          "ETH/USDC",
          0, // no base deposit for BUY
          quoteDeposit,
        );

      await expect(tx)
        .to.emit(otc, "OrderCreated")
        .withArgs(0, signers.alice.address, "ETH/USDC", true, 0, quoteDeposit);

      expect(await otc.orderCount()).to.eq(1);

      const order = await otc.getOrder(0);
      expect(order.maker).to.eq(signers.alice.address);
      expect(order.isBuy).to.eq(true);
      expect(order.status).to.eq(0); // Open
      expect(order.baseDeposit).to.eq(0);
      expect(order.quoteDeposit).to.eq(quoteDeposit);
      expect(order.baseRemaining).to.eq(0);
      expect(order.quoteRemaining).to.eq(quoteDeposit);
    });

    it("should revert BUY order with zero quote deposit", async function () {
      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            0,
            0, // zero quote deposit
          ),
      ).to.be.revertedWithCustomError(otc, "ZeroDeposit");
    });

    it("should revert BUY order if base deposit is non-zero", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            ethers.parseEther("0.1"), // non-zero base deposit for BUY = invalid
            quoteDeposit,
          ),
      ).to.be.revertedWithCustomError(otc, "InvalidDepositType");
    });

    it("should revert if maker has not set OTC as operator", async function () {
      // Wrap but do NOT set OTC as operator
      await (await mockUsdc.mint(signers.alice.address, 1000000n)).wait();
      await (await mockUsdc.connect(signers.alice).approve(cUsdcAddress, 1000000n)).wait();
      await (await cUsdc.connect(signers.alice).wrap(signers.alice.address, 1000000n)).wait();
      // No setOperator to OTC

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            0,
            1000000n,
          ),
      ).to.be.revertedWithCustomError(cUsdc, "ERC7984UnauthorizedSpender");
    });

    it("maker can decrypt their own order price and amount", async function () {
      const quoteDeposit = 2000000n; // 2 USDC
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(2500)
        .add64(50)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "BTC/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      // Decrypt price
      const encPrice = await otc.getPrice(0);
      const decPrice = await fhevm.userDecryptEuint(FhevmType.euint64, encPrice, otcAddress, signers.alice);
      expect(decPrice).to.eq(2500);

      // Decrypt amount
      const encAmount = await otc.getAmount(0);
      const decAmount = await fhevm.userDecryptEuint(FhevmType.euint64, encAmount, otcAddress, signers.alice);
      expect(decAmount).to.eq(50);

      // Decrypt remaining amount (should equal initial amount)
      const encRemaining = await otc.getRemainingAmount(0);
      const decRemaining = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encRemaining,
        otcAddress,
        signers.alice,
      );
      expect(decRemaining).to.eq(50);
    });

    it("should create multiple orders and track count", async function () {
      for (let i = 0; i < 3; i++) {
        const encInput = await fhevm
          .createEncryptedInput(otcAddress, signers.alice.address)
          .add64(1000 + i * 100)
          .add64(10 + i)
          .encrypt();

        const quoteDeposit = 500000n; // 0.5 USDC
        await wrapUsdcAndApprove(signers.alice, quoteDeposit);

        await (
          await otc
            .connect(signers.alice)
            .createOrder(
              encInput.handles[0],
              encInput.inputProof,
              encInput.handles[1],
              encInput.inputProof,
              true,
              "ETH/USDC",
              0,
              quoteDeposit,
            )
        ).wait();
      }

      expect(await otc.orderCount()).to.eq(3);
    });
  });

  // =========================================================================
  //                   SELL ORDER FILL (Taker pays cUSDC, gets cWETH)
  // =========================================================================

  describe("initiateFill + settleFill - SELL Order (cWETH->cUSDC swap)", function () {
    const baseDeposit = ethers.parseEther("1.0");
    const makerPrice = 1500;
    const makerAmount = 100;

    beforeEach(async function () {
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(makerPrice)
        .add64(makerAmount)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false, // SELL
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();
    });

    it("should fill SELL order via two-phase settlement", async function () {
      const takerQuoteAmount = 150000n; // cUSDC to pay maker
      const takerBaseAmount = baseDeposit; // cWETH taker wants

      // Wrap cUSDC for bob (taker) and approve OTC
      await wrapUsdcAndApprove(signers.bob, takerQuoteAmount);

      const takerEncInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500) // exact price match
        .add64(100) // full amount
        .encrypt();

      // Phase 1: Initiate fill (FHE computation, no transfers)
      const initTx = await otc
        .connect(signers.bob)
        .initiateFill(
          0,
          takerEncInput.handles[0],
          takerEncInput.inputProof,
          takerEncInput.handles[1],
          takerEncInput.inputProof,
          takerBaseAmount,
          takerQuoteAmount,
        );

      await expect(initTx)
        .to.emit(otc, "FillInitiated")
        .withArgs(0, 0, signers.bob.address);

      // Pending fill should be created
      expect(await otc.pendingFillCount()).to.eq(1);
      const pf = await otc.getPendingFill(0);
      expect(pf.orderId).to.eq(0);
      expect(pf.taker).to.eq(signers.bob.address);
      expect(pf.status).to.eq(0); // Pending
      expect(pf.takerBaseAmount).to.eq(takerBaseAmount);
      expect(pf.takerQuoteAmount).to.eq(takerQuoteAmount);

      // Phase 2: Settle fill (verify decryption + execute transfers)
      const settleTx = await settleWithValues(signers.bob, 0, true, 100);

      await expect(settleTx)
        .to.emit(otc, "OrderFilled")
        .withArgs(0, 0, takerBaseAmount, takerQuoteAmount);
      await expect(settleTx)
        .to.emit(otc, "FillSettled")
        .withArgs(0, 0);

      // Order should be marked as Filled
      const order = await otc.getOrder(0);
      expect(order.status).to.eq(1); // Filled
      expect(order.baseRemaining).to.eq(0);
    });

    it("should fill when taker price > maker price", async function () {
      const takerQuoteAmount = 200000n;
      const takerBaseAmount = baseDeposit;
      await wrapUsdcAndApprove(signers.bob, takerQuoteAmount);

      const takerEncInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(2000) // higher than maker's 1500
        .add64(100)
        .encrypt();

      // Phase 1: Initiate
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerEncInput.handles[0],
            takerEncInput.inputProof,
            takerEncInput.handles[1],
            takerEncInput.inputProof,
            takerBaseAmount,
            takerQuoteAmount,
          )
      ).wait();

      // Phase 2: Settle
      const tx = await settleWithValues(signers.bob, 0, true, 100);
      await expect(tx).to.emit(otc, "OrderFilled");

      const order = await otc.getOrder(0);
      expect(order.status).to.eq(1); // Filled
    });

    it("should revert if takerBaseAmount exceeds remaining", async function () {
      const takerQuoteAmount = 150000n;
      const takerBaseAmount = baseDeposit + 1n; // more than deposited
      await wrapUsdcAndApprove(signers.bob, takerQuoteAmount);

      const takerEncInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerEncInput.handles[0],
            takerEncInput.inputProof,
            takerEncInput.handles[1],
            takerEncInput.inputProof,
            takerBaseAmount,
            takerQuoteAmount,
          ),
      ).to.be.revertedWithCustomError(otc, "InsufficientRemaining");
    });

    it("maker cannot fill own order", async function () {
      const takerEncInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        otc
          .connect(signers.alice)
          .initiateFill(
            0,
            takerEncInput.handles[0],
            takerEncInput.inputProof,
            takerEncInput.handles[1],
            takerEncInput.inputProof,
            baseDeposit,
            150000n,
          ),
      ).to.be.revertedWithCustomError(otc, "MakerCannotFill");
    });
  });

  // =========================================================================
  //                   BUY ORDER FILL (Taker pays cWETH, gets cUSDC)
  // =========================================================================

  describe("initiateFill + settleFill - BUY Order (cUSDC->cWETH swap)", function () {
    const quoteDeposit = 1000000n; // 1 USDC
    const makerPrice = 1500;
    const makerAmount = 100;

    beforeEach(async function () {
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(makerPrice)
        .add64(makerAmount)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true, // BUY
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();
    });

    it("should fill BUY order via two-phase settlement", async function () {
      const takerBaseAmount = ethers.parseEther("0.5");
      const takerQuoteAmount = quoteDeposit; // cUSDC taker wants from the order

      // Wrap cWETH for bob (taker) and approve OTC
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerEncInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500) // exact price match
        .add64(100) // full amount
        .encrypt();

      // Phase 1: Initiate fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerEncInput.handles[0],
            takerEncInput.inputProof,
            takerEncInput.handles[1],
            takerEncInput.inputProof,
            takerBaseAmount,
            takerQuoteAmount,
          )
      ).wait();

      // Phase 2: Settle fill
      const tx = await settleWithValues(signers.bob, 0, true, 100);

      await expect(tx)
        .to.emit(otc, "OrderFilled")
        .withArgs(0, 0, takerBaseAmount, takerQuoteAmount);

      // Order should be marked as Filled
      const order = await otc.getOrder(0);
      expect(order.status).to.eq(1); // Filled
      expect(order.quoteRemaining).to.eq(0);
    });

    it("should revert if takerQuoteAmount exceeds remaining for BUY fill", async function () {
      const takerEncInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      await expect(
        otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerEncInput.handles[0],
            takerEncInput.inputProof,
            takerEncInput.handles[1],
            takerEncInput.inputProof,
            takerBaseAmount,
            quoteDeposit + 1n, // exceeds remaining
          ),
      ).to.be.revertedWithCustomError(otc, "InsufficientRemaining");
    });

    it("cannot fill a non-open order (after settlement)", async function () {
      // First fill the order (two-phase)
      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerEncInput1 = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerEncInput1.handles[0],
            takerEncInput1.inputProof,
            takerEncInput1.handles[1],
            takerEncInput1.inputProof,
            takerBaseAmount,
            quoteDeposit,
          )
      ).wait();

      // Settle phase 1
      await (await settleWithValues(signers.bob, 0, true, 100)).wait();

      // Try to initiate fill again on the now-Filled order
      const takerBaseAmount2 = ethers.parseEther("0.1");
      await wrapEthAndApprove(signers.carol, takerBaseAmount2);

      const takerEncInput2 = await fhevm
        .createEncryptedInput(otcAddress, signers.carol.address)
        .add64(1500)
        .add64(50)
        .encrypt();

      await expect(
        otc
          .connect(signers.carol)
          .initiateFill(
            0,
            takerEncInput2.handles[0],
            takerEncInput2.inputProof,
            takerEncInput2.handles[1],
            takerEncInput2.inputProof,
            takerBaseAmount2,
            500000n,
          ),
      ).to.be.revertedWithCustomError(otc, "OrderNotOpen");
    });

    it("should revert with InvalidOrderId for non-existent order", async function () {
      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerEncInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await expect(
        otc
          .connect(signers.bob)
          .initiateFill(
            999,
            takerEncInput.handles[0],
            takerEncInput.inputProof,
            takerEncInput.handles[1],
            takerEncInput.inputProof,
            takerBaseAmount,
            quoteDeposit,
          ),
      ).to.be.revertedWithCustomError(otc, "InvalidOrderId");
    });
  });

  // =========================================================================
  //                       ENCRYPTED PARTIAL FILLS
  // =========================================================================

  describe("initiateFill + settleFill - Encrypted Partial Fills (SELL order)", function () {
    it("should compute partial fill using FHE.min when taker wants less", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      // Maker creates SELL order for 100 units with 1 cWETH
      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            false, // SELL
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      // Taker wants only 30 units at matching price (partial cWETH)
      const partialBase = ethers.parseEther("0.3");
      const partialQuote = 45000n;
      await wrapUsdcAndApprove(signers.bob, partialQuote);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(30) // partial fill
        .encrypt();

      // Phase 1: Initiate fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            partialBase,
            partialQuote,
          )
      ).wait();

      // Phase 2: Settle with partial fill amount (30 units)
      await (await settleWithValues(signers.bob, 0, true, 30)).wait();

      // Verify the fill amount is 30 (min of 30, 100)
      const encFillAmount = await otc.getFillAmount(0);
      const decFillAmount = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        otcAddress,
        signers.bob,
      );
      expect(decFillAmount).to.eq(30);

      // Order should still be Open (partial fill)
      const order = await otc.getOrder(0);
      expect(order.status).to.eq(0); // Open
      expect(order.baseRemaining).to.eq(baseDeposit - partialBase);
    });

    it("fill amount should be capped at remaining when taker wants more", async function () {
      const baseDeposit = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      // Maker creates SELL order for 50 units with 0.5 cWETH
      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      // Taker wants 200 units (more than available), but specifies full base deposit
      const takerQuote = 100000n;
      await wrapUsdcAndApprove(signers.bob, takerQuote);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1000)
        .add64(200) // wants more than available (encrypted)
        .encrypt();

      // Phase 1: Initiate fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            baseDeposit, // take all remaining cWETH
            takerQuote,
          )
      ).wait();

      // Phase 2: Settle (fill capped at 50)
      await (await settleWithValues(signers.bob, 0, true, 50)).wait();

      // Fill amount should be capped at 50 (min of 200, 50)
      const encFillAmount = await otc.getFillAmount(0);
      const decFillAmount = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        otcAddress,
        signers.bob,
      );
      expect(decFillAmount).to.eq(50);
    });
  });

  // =========================================================================
  //                    ENCRYPTED SETTLEMENT TOTAL
  // =========================================================================

  describe("initiateFill + settleFill - Encrypted Settlement Total", function () {
    it("should compute encrypted total as price * fillAmount", async function () {
      const price = 1500;
      const amount = 100;
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(price)
        .add64(amount)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true, // BUY
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(price) // exact match
        .add64(amount) // full fill
        .encrypt();

      // Phase 1: Initiate fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            takerBaseAmount,
            quoteDeposit,
          )
      ).wait();

      // Phase 2: Settle
      await (await settleWithValues(signers.bob, 0, true, 100)).wait();

      // Decrypt the settlement total
      const encTotal = await otc.getFillTotal(0);
      const decTotal = await fhevm.userDecryptEuint(FhevmType.euint64, encTotal, otcAddress, signers.bob);
      expect(decTotal).to.eq(BigInt(price) * BigInt(amount)); // 1500 * 100 = 150000
    });
  });

  // =========================================================================
  //                         TOKEN ESCROW
  // =========================================================================

  describe("Token Escrow - Dual Confidential Asset", function () {
    it("cWETH should be held in OTC contract after SELL order creation", async function () {
      const baseDeposit = ethers.parseEther("2.5");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      // The underlying ETH should be in cWETH contract, and cWETH tokens in OTC
      const cWethEthBalance = await ethers.provider.getBalance(cWethAddress);
      expect(cWethEthBalance).to.eq(baseDeposit);
    });

    it("cUSDC should be held in OTC contract after BUY order creation", async function () {
      const quoteDeposit = 2500000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      // The underlying USDC should be in cUSDC contract
      const cUsdcUnderlyingBalance = await mockUsdc.balanceOf(cUsdcAddress);
      expect(cUsdcUnderlyingBalance).to.eq(quoteDeposit);
    });

    it("baseToken and quoteToken addresses should be set correctly", async function () {
      expect(await otc.baseToken()).to.eq(cWethAddress);
      expect(await otc.quoteToken()).to.eq(cUsdcAddress);
    });
  });

  // =========================================================================
  //                      CANCEL ORDER
  // =========================================================================

  describe("cancelOrder", function () {
    it("maker can cancel SELL order and get cWETH refund", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      const tx = await otc.connect(signers.alice).cancelOrder(0);

      await expect(tx).to.emit(otc, "OrderCancelled").withArgs(0, baseDeposit, 0);

      const order = await otc.getOrder(0);
      expect(order.status).to.eq(2); // Cancelled
      expect(order.baseRemaining).to.eq(0);
    });

    it("maker can cancel BUY order and get cUSDC refund", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      await expect(otc.connect(signers.alice).cancelOrder(0))
        .to.emit(otc, "OrderCancelled")
        .withArgs(0, 0, quoteDeposit);

      const order = await otc.getOrder(0);
      expect(order.status).to.eq(2); // Cancelled
      expect(order.quoteRemaining).to.eq(0);
    });

    it("non-maker cannot cancel order", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      await expect(otc.connect(signers.bob).cancelOrder(0)).to.be.revertedWithCustomError(otc, "NotMaker");
    });

    it("cannot cancel already filled order", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      // Two-phase fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            takerBaseAmount,
            quoteDeposit,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 0, true, 100)).wait();

      await expect(otc.connect(signers.alice).cancelOrder(0)).to.be.revertedWithCustomError(
        otc,
        "OrderNotOpen",
      );
    });

    it("cannot cancel non-existent order", async function () {
      await expect(otc.connect(signers.alice).cancelOrder(999)).to.be.revertedWithCustomError(
        otc,
        "InvalidOrderId",
      );
    });
  });

  // =========================================================================
  //                    FAIR TIEBREAKING (RANDOMNESS)
  // =========================================================================

  describe("Fair Tiebreaking", function () {
    it("fill should have a random priority score", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1000)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1000)
        .add64(100)
        .encrypt();

      // Two-phase fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            takerBaseAmount,
            quoteDeposit,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 0, true, 100)).wait();

      // The priority score handle should exist (non-zero)
      const encPriority = await otc.getFillPriorityScore(0);
      expect(encPriority).to.not.eq(ethers.ZeroHash);

      // Maker should be able to decrypt it
      const decPriority = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encPriority,
        otcAddress,
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
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      // Two-phase fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            takerBaseAmount,
            quoteDeposit,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 0, true, 100)).wait();

      // Maker should be able to decrypt the taker's encrypted address
      const encTaker = await otc.getEncryptedTaker(0);
      const decTaker = await fhevm.userDecryptEaddress(encTaker, otcAddress, signers.alice);
      expect(decTaker.toLowerCase()).to.eq(signers.bob.address.toLowerCase());
    });

    it("taker can decrypt their own encrypted address from the fill", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      // Two-phase fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            takerBaseAmount,
            quoteDeposit,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 0, true, 100)).wait();

      // Bob can decrypt his own encrypted taker address from the fill record
      const encFillTaker = await otc.getFillEncryptedTaker(0);
      const decFillTaker = await fhevm.userDecryptEaddress(encFillTaker, otcAddress, signers.bob);
      expect(decFillTaker.toLowerCase()).to.eq(signers.bob.address.toLowerCase());
    });
  });

  // =========================================================================
  //               COMPLIANCE / AUDITOR ACCESS
  // =========================================================================

  describe("Auditor Compliance Access", function () {
    it("auditor can decrypt order details after being granted access", async function () {
      // Set auditor
      await (await otc.connect(signers.deployer).setAuditor(signers.auditor.address)).wait();

      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      // Create SELL order
      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      // Fill SELL order: taker pays cUSDC, gets cWETH (two-phase)
      const takerQuote = 1000000n;
      await wrapUsdcAndApprove(signers.bob, takerQuote);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            baseDeposit,
            takerQuote,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 0, true, 200)).wait();

      // Owner grants auditor access
      await expect(otc.connect(signers.deployer).grantAuditorAccess(0))
        .to.emit(otc, "AuditorAccessGranted")
        .withArgs(0);

      // Auditor can now decrypt everything
      const encPrice = await otc.getPrice(0);
      const decPrice = await fhevm.userDecryptEuint(FhevmType.euint64, encPrice, otcAddress, signers.auditor);
      expect(decPrice).to.eq(5000);

      const encAmount = await otc.getAmount(0);
      const decAmount = await fhevm.userDecryptEuint(FhevmType.euint64, encAmount, otcAddress, signers.auditor);
      expect(decAmount).to.eq(200);

      // Auditor can decrypt fill details too
      const encFillAmount = await otc.getFillAmount(0);
      const decFillAmount = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        otcAddress,
        signers.auditor,
      );
      expect(decFillAmount).to.eq(200);

      // Auditor can decrypt the settlement total
      const encFillTotal = await otc.getFillTotal(0);
      const decFillTotal = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillTotal,
        otcAddress,
        signers.auditor,
      );
      expect(decFillTotal).to.eq(BigInt(5000) * BigInt(200));
    });

    it("grantAuditorAccess reverts when no auditor is set", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      await expect(otc.connect(signers.deployer).grantAuditorAccess(0)).to.be.revertedWithCustomError(
        otc,
        "ZeroAddress",
      );
    });

    it("non-owner cannot grant auditor access", async function () {
      await (await otc.connect(signers.deployer).setAuditor(signers.auditor.address)).wait();

      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      await expect(otc.connect(signers.alice).grantAuditorAccess(0)).to.be.revertedWithCustomError(
        otc,
        "NotOwner",
      );
    });
  });

  // =========================================================================
  //                    POST-TRADE TRANSPARENCY
  // =========================================================================

  describe("Post-Trade Transparency", function () {
    it("fill amount should be publicly decryptable after settlement", async function () {
      const baseDeposit = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      const takerQuote = 50000n;
      await wrapUsdcAndApprove(signers.bob, takerQuote);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      // Two-phase fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            baseDeposit,
            takerQuote,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 0, true, 50)).wait();

      // The fill amount was made publicly decryptable via FHE.makePubliclyDecryptable
      // in initiateFill (before settlement).
      const encFillAmount = await otc.getFillAmount(0);
      expect(encFillAmount).to.not.eq(ethers.ZeroHash);

      // Both maker and taker can decrypt
      const decFillByMaker = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        otcAddress,
        signers.alice,
      );
      expect(decFillByMaker).to.eq(50);

      const decFillByTaker = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encFillAmount,
        otcAddress,
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
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      await expect(otc.connect(signers.alice).grantAccess(0, signers.carol.address))
        .to.emit(otc, "AccessGranted")
        .withArgs(0, signers.carol.address);

      // Carol can now decrypt
      const encPrice = await otc.getPrice(0);
      const decPrice = await fhevm.userDecryptEuint(FhevmType.euint64, encPrice, otcAddress, signers.carol);
      expect(decPrice).to.eq(5000);

      const encAmount = await otc.getAmount(0);
      const decAmount = await fhevm.userDecryptEuint(FhevmType.euint64, encAmount, otcAddress, signers.carol);
      expect(decAmount).to.eq(200);
    });

    it("non-maker cannot grant access", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      await expect(
        otc.connect(signers.bob).grantAccess(0, signers.carol.address),
      ).to.be.revertedWithCustomError(otc, "NotMaker");
    });

    it("cannot grant access to zero address", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      await expect(
        otc.connect(signers.alice).grantAccess(0, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(otc, "ZeroAddress");
    });
  });

  // =========================================================================
  //                   ACCESS REQUEST / GRANT TRACKING
  // =========================================================================

  describe("requestAccess", function () {
    it("taker can request access to an open order", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      await expect(otc.connect(signers.bob).requestAccess(0))
        .to.emit(otc, "AccessRequested")
        .withArgs(0, signers.bob.address);

      const requests = await otc.getAccessRequests(0);
      expect(requests.length).to.eq(1);
      expect(requests[0]).to.eq(signers.bob.address);
    });

    it("maker cannot request access to own order", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      await expect(otc.connect(signers.alice).requestAccess(0)).to.be.revertedWith(
        "Maker cannot request",
      );
    });

    it("same address cannot request access twice", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      await (await otc.connect(signers.bob).requestAccess(0)).wait();

      await expect(otc.connect(signers.bob).requestAccess(0)).to.be.revertedWith(
        "Already requested",
      );
    });

    it("cannot request access for invalid orderId", async function () {
      await expect(otc.connect(signers.bob).requestAccess(999)).to.be.revertedWithCustomError(
        otc,
        "InvalidOrderId",
      );
    });

    it("getAccessRequests reverts for invalid orderId", async function () {
      await expect(otc.getAccessRequests(999)).to.be.revertedWithCustomError(
        otc,
        "InvalidOrderId",
      );
    });

    it("getGrantedAddresses reverts for invalid orderId", async function () {
      await expect(otc.getGrantedAddresses(999)).to.be.revertedWithCustomError(
        otc,
        "InvalidOrderId",
      );
    });
  });

  describe("grantAccess tracking", function () {
    it("grantAccess tracks granted addresses", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      // Grant access to bob and carol
      await (await otc.connect(signers.alice).grantAccess(0, signers.bob.address)).wait();
      await (await otc.connect(signers.alice).grantAccess(0, signers.carol.address)).wait();

      const granted = await otc.getGrantedAddresses(0);
      expect(granted.length).to.eq(2);
      expect(granted[0]).to.eq(signers.bob.address);
      expect(granted[1]).to.eq(signers.carol.address);
    });

    it("granting access twice to same address does not duplicate", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const encInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(5000)
        .add64(200)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            encInput.handles[0],
            encInput.inputProof,
            encInput.handles[1],
            encInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      // Grant access to bob twice
      await (await otc.connect(signers.alice).grantAccess(0, signers.bob.address)).wait();
      await (await otc.connect(signers.alice).grantAccess(0, signers.bob.address)).wait();

      const granted = await otc.getGrantedAddresses(0);
      expect(granted.length).to.eq(1);
      expect(granted[0]).to.eq(signers.bob.address);
    });
  });

  // =========================================================================
  //                        VIEW FUNCTIONS
  // =========================================================================

  describe("View Functions", function () {
    it("should return correct order count", async function () {
      expect(await otc.orderCount()).to.eq(0);
      expect(await otc.fillCount()).to.eq(0);
    });

    it("should revert getOrder for invalid orderId", async function () {
      await expect(otc.getOrder(0)).to.be.revertedWithCustomError(otc, "InvalidOrderId");
    });

    it("should revert getPrice for invalid orderId", async function () {
      await expect(otc.getPrice(0)).to.be.revertedWithCustomError(otc, "InvalidOrderId");
    });

    it("should revert getAmount for invalid orderId", async function () {
      await expect(otc.getAmount(0)).to.be.revertedWithCustomError(otc, "InvalidOrderId");
    });

    it("should revert getRemainingAmount for invalid orderId", async function () {
      await expect(otc.getRemainingAmount(0)).to.be.revertedWithCustomError(otc, "InvalidOrderId");
    });

    it("should revert getEncryptedTaker for invalid orderId", async function () {
      await expect(otc.getEncryptedTaker(0)).to.be.revertedWithCustomError(otc, "InvalidOrderId");
    });

    it("should revert getFill for invalid fillId", async function () {
      await expect(otc.getFill(0)).to.be.revertedWithCustomError(otc, "InvalidFillId");
    });

    it("should revert getFillAmount for invalid fillId", async function () {
      await expect(otc.getFillAmount(0)).to.be.revertedWithCustomError(otc, "InvalidFillId");
    });

    it("should revert getFillTotal for invalid fillId", async function () {
      await expect(otc.getFillTotal(0)).to.be.revertedWithCustomError(otc, "InvalidFillId");
    });

    it("should revert getFillPriorityScore for invalid fillId", async function () {
      await expect(otc.getFillPriorityScore(0)).to.be.revertedWithCustomError(otc, "InvalidFillId");
    });

    it("should revert getFillEncryptedTaker for invalid fillId", async function () {
      await expect(otc.getFillEncryptedTaker(0)).to.be.revertedWithCustomError(otc, "InvalidFillId");
    });

    it("getOrderFills should return fill IDs for an order", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      // Two-phase fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            takerBaseAmount,
            quoteDeposit,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 0, true, 100)).wait();

      const fillIds = await otc.getOrderFills(0);
      expect(fillIds.length).to.eq(1);
      expect(fillIds[0]).to.eq(0);
    });
  });

  // =========================================================================
  //                   PROTOCOL VOLUME TRACKING
  // =========================================================================

  describe("Protocol Volume Tracking", function () {
    it("total volume should accumulate across fills", async function () {
      // Create and fill first order (SELL)
      const baseDeposit1 = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.alice, baseDeposit1);

      const maker1Input = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            maker1Input.handles[0],
            maker1Input.inputProof,
            maker1Input.handles[1],
            maker1Input.inputProof,
            false,
            "ETH/USDC",
            baseDeposit1,
            0,
          )
      ).wait();

      const taker1Quote = 50000n;
      await wrapUsdcAndApprove(signers.bob, taker1Quote);

      const taker1Input = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      // Two-phase fill for order 0
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            taker1Input.handles[0],
            taker1Input.inputProof,
            taker1Input.handles[1],
            taker1Input.inputProof,
            baseDeposit1,
            taker1Quote,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 0, true, 50)).wait();

      // Create and fill second order (BUY)
      const quoteDeposit2 = 300000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit2);

      const maker2Input = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(2000)
        .add64(30)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            maker2Input.handles[0],
            maker2Input.inputProof,
            maker2Input.handles[1],
            maker2Input.inputProof,
            true,
            "BTC/USDC",
            0,
            quoteDeposit2,
          )
      ).wait();

      const taker2Base = ethers.parseEther("0.3");
      await wrapEthAndApprove(signers.bob, taker2Base);

      const taker2Input = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(2000)
        .add64(30)
        .encrypt();

      // Two-phase fill for order 1
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            1,
            taker2Input.handles[0],
            taker2Input.inputProof,
            taker2Input.handles[1],
            taker2Input.inputProof,
            taker2Base,
            quoteDeposit2,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 1, true, 30)).wait();

      expect(await otc.totalFillCount()).to.eq(2);

      // Total volume handle should exist
      const encVolume = await otc.getTotalVolume();
      expect(encVolume).to.not.eq(ethers.ZeroHash);
    });
  });

  // =========================================================================
  //                       TAKER FILL TRACKING
  // =========================================================================

  describe("getMyFills", function () {
    it("taker can see their fills via getMyFills", async function () {
      // Create a SELL order (Alice deposits cWETH)
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      // Bob fills the order (two-phase)
      const takerQuote = 150000n;
      await wrapUsdcAndApprove(signers.bob, takerQuote);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            baseDeposit,
            takerQuote,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 0, true, 100)).wait();

      // Bob should see his fill
      const bobFills = await otc.connect(signers.bob).getMyFills();
      expect(bobFills.length).to.eq(1);
      expect(bobFills[0]).to.eq(0);

      // Alice (maker, not taker) should have no fills
      const aliceFills = await otc.connect(signers.alice).getMyFills();
      expect(aliceFills.length).to.eq(0);

      // Carol should have no fills
      const carolFills = await otc.connect(signers.carol).getMyFills();
      expect(carolFills.length).to.eq(0);
    });

    it("taker fills accumulate across multiple orders", async function () {
      // Create first SELL order
      const baseDeposit1 = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.alice, baseDeposit1);

      const maker1Input = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            maker1Input.handles[0],
            maker1Input.inputProof,
            maker1Input.handles[1],
            maker1Input.inputProof,
            false,
            "ETH/USDC",
            baseDeposit1,
            0,
          )
      ).wait();

      // Bob fills first order (two-phase)
      const taker1Quote = 50000n;
      await wrapUsdcAndApprove(signers.bob, taker1Quote);

      const taker1Input = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1000)
        .add64(50)
        .encrypt();

      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            taker1Input.handles[0],
            taker1Input.inputProof,
            taker1Input.handles[1],
            taker1Input.inputProof,
            baseDeposit1,
            taker1Quote,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 0, true, 50)).wait();

      // Create second BUY order
      const quoteDeposit2 = 300000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit2);

      const maker2Input = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(2000)
        .add64(30)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            maker2Input.handles[0],
            maker2Input.inputProof,
            maker2Input.handles[1],
            maker2Input.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit2,
          )
      ).wait();

      // Bob fills second order (two-phase)
      const taker2Base = ethers.parseEther("0.3");
      await wrapEthAndApprove(signers.bob, taker2Base);

      const taker2Input = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(2000)
        .add64(30)
        .encrypt();

      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            1,
            taker2Input.handles[0],
            taker2Input.inputProof,
            taker2Input.handles[1],
            taker2Input.inputProof,
            taker2Base,
            quoteDeposit2,
          )
      ).wait();
      await (await settleWithValues(signers.bob, 1, true, 30)).wait();

      // Bob should see both fills
      const bobFills = await otc.connect(signers.bob).getMyFills();
      expect(bobFills.length).to.eq(2);
      expect(bobFills[0]).to.eq(0);
      expect(bobFills[1]).to.eq(1);
    });
  });

  // =========================================================================
  //                        EDGE CASES
  // =========================================================================

  describe("Edge Cases", function () {
    it("fill with zero taker amount should produce cancelled fill", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      const takerBaseAmount = ethers.parseEther("0.1");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(0) // zero amount
        .encrypt();

      // Phase 1: Initiate fill
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            takerBaseAmount,
            500000n, // partial cUSDC
          )
      ).wait();

      // Phase 2: Settle with zero fill amount (should cancel)
      const tx = await settleWithValues(signers.bob, 0, true, 0);
      await expect(tx).to.emit(otc, "FillCancelled").withArgs(0, "Zero fill");

      // Pending fill should be cancelled
      const pf = await otc.getPendingFill(0);
      expect(pf.status).to.eq(2); // Cancelled
    });

    it("constructor should revert with zero address base token", async function () {
      const factory = (await ethers.getContractFactory("ConfidentialOTC")) as ConfidentialOTC__factory;
      await expect(factory.deploy(ethers.ZeroAddress, cUsdcAddress, true)).to.be.revertedWithCustomError(
        otc,
        "ZeroAddress",
      );
    });

    it("constructor should revert with zero address quote token", async function () {
      const factory = (await ethers.getContractFactory("ConfidentialOTC")) as ConfidentialOTC__factory;
      await expect(factory.deploy(cWethAddress, ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
        otc,
        "ZeroAddress",
      );
    });
  });

  // =========================================================================
  //                   THREE-PHASE SETTLEMENT TESTS
  // =========================================================================

  describe("Three-Phase Settlement", function () {
    it("should cancel fill when price does not match", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(2000) // maker wants 2000
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            false, // SELL
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      const takerQuoteAmount = 100000n;
      await wrapUsdcAndApprove(signers.bob, takerQuoteAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1000) // taker offers 1000 (below maker's 2000)
        .add64(100)
        .encrypt();

      // Phase 1: Initiate (FHE computation detects price mismatch)
      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            baseDeposit,
            takerQuoteAmount,
          )
      ).wait();

      // Phase 2: Settle with priceMatched=false (decrypted result)
      const tx = await settleWithValues(signers.bob, 0, false, 0);
      await expect(tx).to.emit(otc, "FillCancelled").withArgs(0, "Price mismatch");

      // Pending fill should be cancelled
      const pf = await otc.getPendingFill(0);
      expect(pf.status).to.eq(2); // Cancelled

      // Order should remain Open (no transfer happened)
      const order = await otc.getOrder(0);
      expect(order.status).to.eq(0); // Open
      expect(order.baseRemaining).to.eq(baseDeposit);
    });

    it("should revert settleFill on already settled fill", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            takerBaseAmount,
            quoteDeposit,
          )
      ).wait();

      // First settle succeeds
      await (await settleWithValues(signers.bob, 0, true, 100)).wait();

      // Second settle should fail
      await expect(settleWithValues(signers.bob, 0, true, 100)).to.be.revertedWithCustomError(
        otc,
        "NotPending",
      );
    });

    it("should revert settleFill on already cancelled fill", async function () {
      const quoteDeposit = 1000000n;
      await wrapUsdcAndApprove(signers.alice, quoteDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            true,
            "ETH/USDC",
            0,
            quoteDeposit,
          )
      ).wait();

      const takerBaseAmount = ethers.parseEther("0.5");
      await wrapEthAndApprove(signers.bob, takerBaseAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            takerBaseAmount,
            quoteDeposit,
          )
      ).wait();

      // Cancel the fill
      await (await settleWithValues(signers.bob, 0, false, 0)).wait();

      // Trying to settle again should fail
      await expect(settleWithValues(signers.bob, 0, true, 100)).to.be.revertedWithCustomError(
        otc,
        "NotPending",
      );
    });

    it("should revert settleFill with invalid pending fill ID", async function () {
      await expect(settleWithValues(signers.bob, 999, true, 100)).to.be.revertedWithCustomError(
        otc,
        "InvalidPendingFillId",
      );
    });

    it("should revert getPendingFill with invalid ID", async function () {
      await expect(otc.getPendingFill(999)).to.be.revertedWithCustomError(otc, "InvalidPendingFillId");
    });

    it("pendingFillCount should track correctly", async function () {
      expect(await otc.pendingFillCount()).to.eq(0);

      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      const takerQuoteAmount = 150000n;
      await wrapUsdcAndApprove(signers.bob, takerQuoteAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            baseDeposit,
            takerQuoteAmount,
          )
      ).wait();

      expect(await otc.pendingFillCount()).to.eq(1);
    });

    it("anyone can call settleFill (not just taker)", async function () {
      const baseDeposit = ethers.parseEther("1.0");
      await wrapEthAndApprove(signers.alice, baseDeposit);

      const makerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.alice.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.alice)
          .createOrder(
            makerInput.handles[0],
            makerInput.inputProof,
            makerInput.handles[1],
            makerInput.inputProof,
            false,
            "ETH/USDC",
            baseDeposit,
            0,
          )
      ).wait();

      const takerQuoteAmount = 150000n;
      await wrapUsdcAndApprove(signers.bob, takerQuoteAmount);

      const takerInput = await fhevm
        .createEncryptedInput(otcAddress, signers.bob.address)
        .add64(1500)
        .add64(100)
        .encrypt();

      await (
        await otc
          .connect(signers.bob)
          .initiateFill(
            0,
            takerInput.handles[0],
            takerInput.inputProof,
            takerInput.handles[1],
            takerInput.inputProof,
            baseDeposit,
            takerQuoteAmount,
          )
      ).wait();

      // Carol (third party) settles the fill
      const tx = await settleWithValues(signers.carol, 0, true, 100);
      await expect(tx).to.emit(otc, "FillSettled").withArgs(0, 0);
    });
  });
});
