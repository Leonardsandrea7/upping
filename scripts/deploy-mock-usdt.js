const hre = require("hardhat");

/**
 * Despliega MockUSDT — SOLO para testnet.
 * Uso: npx hardhat run scripts/deploy-mock-usdt.js --network baseSepolia
 */
async function main() {
  if (hre.network.name === "base") {
    throw new Error("No despliegues MockUSDT en mainnet. Usa el USDT real.");
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Desplegando MockUSDT con la cuenta:", deployer.address);

  const MockUSDT = await hre.ethers.getContractFactory("MockUSDT");
  const mockUsdt = await MockUSDT.deploy();
  await mockUsdt.waitForDeployment();

  const address = await mockUsdt.getAddress();
  console.log("MockUSDT desplegado en:", address);
  console.log(
    "\nSiguiente paso: pega esta dirección en scripts/deploy.js " +
    "(USDT_ADDRESSES.baseSepolia) y corre: npm run deploy:testnet"
  );
  console.log(
    "\nPara obtener tokens de prueba, cualquier wallet puede llamar a " +
    `faucet(amount) directamente en el contrato ${address}.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
