import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get } = hre.deployments;

  const cWETH = await get("ConfidentialWETH");
  const cUSDC = await get("ConfidentialUSDC");

  const otc = await deploy("ConfidentialOTC", {
    from: deployer,
    args: [cWETH.address, cUSDC.address, false],
    log: true,
  });
  console.log(`ConfidentialOTC (Dark Pool): `, otc.address);

  console.log(`\n--- Post-Deploy Instructions ---`);
  console.log(`Users must call setOperator on cWETH and cUSDC to authorize the OTC contract:`);
  console.log(`  cWETH.setOperator(${otc.address}, type(uint48).max)`);
  console.log(`  cUSDC.setOperator(${otc.address}, type(uint48).max)`);
};

export default func;
func.id = "deploy_otc";
func.tags = ["OTC"];
func.dependencies = ["cWETH", "cUSDC"];
