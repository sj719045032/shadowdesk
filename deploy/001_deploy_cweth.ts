import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const cWETH = await deploy("ConfidentialWETH", {
    from: deployer,
    args: [],
    log: true,
  });
  console.log(`ConfidentialWETH (cWETH): `, cWETH.address);
};

export default func;
func.id = "deploy_cweth";
func.tags = ["cWETH"];
