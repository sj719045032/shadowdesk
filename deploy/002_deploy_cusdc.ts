import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const cUSDC = await deploy("ConfidentialUSDC", {
    from: deployer,
    args: [SEPOLIA_USDC],
    log: true,
  });
  console.log(`ConfidentialUSDC (cUSDC): `, cUSDC.address);
  console.log(`Underlying USDC: `, SEPOLIA_USDC);
};

export default func;
func.id = "deploy_cusdc";
func.tags = ["cUSDC"];
