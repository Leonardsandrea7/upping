const hre = require("hardhat");

/**
 * Despliega UppingEscrow.
 *
 * Uso (testnet, recomendado):
 *   npx hardhat run scripts/deploy.js --network baseSepolia
 *
 * Uso (mainnet, SOLO después de probar exhaustivamente en testnet):
 *   npx hardhat run scripts/deploy.js --network base
 */
async function main() {
  const network = hre.network.name;

  // Direcciones de USDT según red. En testnet normalmente se despliega un
  // token de prueba propio (mock) porque el USDT real no existe en testnet.
  const USDT_ADDRESSES = {
    base: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb", // USDbC en Base mainnet — VERIFICAR antes de usar
    baseSepolia: null, // debes desplegar un MockUSDT propio para pruebas — ver scripts/deploy-mock-usdt.js
  };

  const tokenAddress = USDT_ADDRESSES[network];
  if (!tokenAddress) {
    throw new Error(
      `No hay dirección de token configurada para la red "${network}". ` +
      `Si es testnet, despliega primero un MockUSDT y pon su dirección aquí.`
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Desplegando con la cuenta:", deployer.address);
  console.log("Red:", network);

  // El arbitro es quien resuelve disputas — normalmente una wallet separada
  // del deployer, controlada por el equipo de Upping (o un multisig).
  const arbiterAddress = process.env.ARBITER_ADDRESS || deployer.address;

  // La wallet que recibe TU comisión en cada operación liberada.
  // Usa una wallet separada de tu wallet personal — es más fácil de contabilizar.
  const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;

  // Comisión inicial en basis points. 150 = 1.5%. Se puede cambiar después
  // con setPlatformFee() sin redesplegar el contrato.
  const initialFeeBps = process.env.PLATFORM_FEE_BPS || 150;

  const UppingEscrow = await hre.ethers.getContractFactory("UppingEscrow");
  const escrow = await UppingEscrow.deploy(tokenAddress, arbiterAddress, treasuryAddress, initialFeeBps);
  await escrow.waitForDeployment();

  console.log("UppingEscrow desplegado en:", await escrow.getAddress());
  console.log("Token USDT usado:", tokenAddress);
  console.log("Arbitro configurado:", arbiterAddress);
  console.log("Tesorería (recibe tu comisión):", treasuryAddress);
  console.log("Comisión inicial:", Number(initialFeeBps) / 100, "%");

  if (network === "base") {
    console.log(
      "\n⚠️  Desplegaste en MAINNET. Confirma que ya probaste el flujo completo " +
      "en baseSepolia con múltiples proveedores y operaciones antes de anunciar esto públicamente."
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
