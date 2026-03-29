import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const deployed = await deploy("ConfidentialOTC", {
    from: deployer,
    log: true,
  });

  console.log(`ConfidentialOTC (Dark Pool) contract: `, deployed.address);
};
export default func;
func.id = "deploy_confidentialOTC";
func.tags = ["ConfidentialOTC"];
