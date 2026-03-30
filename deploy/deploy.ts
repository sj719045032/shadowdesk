import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

// Sepolia USDC address
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  // 1. Deploy ConfidentialWETH (ERC7984-based)
  const cWETH = await deploy("ConfidentialWETH", {
    from: deployer,
    args: [],
    log: true,
  });
  console.log(`ConfidentialWETH (cWETH): `, cWETH.address);

  // 2. Deploy ConfidentialUSDC with Sepolia USDC as underlying (ERC7984ERC20Wrapper-based)
  const cUSDC = await deploy("ConfidentialUSDC", {
    from: deployer,
    args: [SEPOLIA_USDC],
    log: true,
  });
  console.log(`ConfidentialUSDC (cUSDC): `, cUSDC.address);
  console.log(`Underlying USDC: `, SEPOLIA_USDC);

  // 3. Deploy ConfidentialOTC with cWETH and cUSDC addresses
  //    skipVerification=false on Sepolia (KMS proof verification enabled)
  const otc = await deploy("ConfidentialOTC", {
    from: deployer,
    args: [cWETH.address, cUSDC.address, false],
    log: true,
  });
  console.log(`ConfidentialOTC (Dark Pool): `, otc.address);

  // 4. Set the OTC contract as an operator on both wrappers using ERC7984's setOperator.
  //    This replaces the old setTrustedCaller pattern.
  //    uint48 max (~8.9 million years) means the operator never expires.
  const { ethers } = hre;
  const cWethContract = await ethers.getContractAt("ConfidentialWETH", cWETH.address);
  const cUsdcContract = await ethers.getContractAt("ConfidentialUSDC", cUSDC.address);

  // Note: setOperator is called by the deployer to authorize the OTC contract
  // to call confidentialTransferFrom on tokens the deployer holds.
  // In production, each user sets the OTC as their operator before interacting.
  // For the deploy script, we just log instructions.
  console.log(`\n--- Post-Deploy Instructions ---`);
  console.log(`Users must call setOperator on cWETH and cUSDC to authorize the OTC contract:`);
  console.log(`  cWETH.setOperator(${otc.address}, type(uint48).max)`);
  console.log(`  cUSDC.setOperator(${otc.address}, type(uint48).max)`);
};
export default func;
func.id = "deploy_confidentialOTC";
func.tags = ["ConfidentialOTC"];
