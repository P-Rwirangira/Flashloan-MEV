import { ethers } from 'hardhat';
import { parseEther } from 'ethers';

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log('Deploying contracts with the account:', deployer.address);
  console.log('Account balance:', (await ethers.provider.getBalance(deployer.address)).toString());

  // Deploy FlashExecutor with minimum profit of 0.001 ETH (1e15 wei)
  const minProfit = parseEther('0.001');

  const FlashExecutor = await ethers.getContractFactory('FlashExecutor');
  const flashExecutor = await FlashExecutor.deploy(minProfit);

  await flashExecutor.waitForDeployment();

  const contractAddress = await flashExecutor.getAddress();

  console.log('FlashExecutor deployed to:', contractAddress);
  console.log('Minimum profit set to:', minProfit.toString(), 'wei');
  console.log('Owner:', await flashExecutor.owner());

  // Save deployment info
  const deploymentInfo = {
    contractAddress,
    minProfit: minProfit.toString(),
    owner: await flashExecutor.owner(),
    network: (await ethers.provider.getNetwork()).name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deploymentBlock: await ethers.provider.getBlockNumber(),
    deploymentTime: new Date().toISOString(),
  };

  console.log('\nDeployment Info:', JSON.stringify(deploymentInfo, null, 2));

  return deploymentInfo;
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
