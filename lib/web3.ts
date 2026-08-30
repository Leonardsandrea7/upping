"use client";

import { BrowserProvider, Contract, parseUnits, formatUnits } from "ethers";

// Se completa automáticamente después de correr scripts/deploy.js
export const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? "";
export const USDT_ADDRESS = process.env.NEXT_PUBLIC_USDT_ADDRESS ?? "";

const ESCROW_ABI = [
  "function depositLiquidity(uint256 amount) external",
  "function withdrawLiquidity(uint256 amount) external",
  "function releaseToClient(bytes32 operationId) external",
  "function markDisputed(bytes32 operationId) external",
  "function availableLiquidity(address provider) external view returns (uint256)",
  "function providers(address) external view returns (uint256 totalDeposited, uint256 locked, bool active)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

/**
 * Conecta con MetaMask y devuelve el signer del usuario/proveedor.
 * Lanza un error claro si MetaMask no está instalado.
 */
export async function connectWallet() {
  if (typeof window === "undefined" || !(window as any).ethereum) {
    throw new Error("No se detectó MetaMask. Instálalo desde metamask.io para continuar.");
  }
  const provider = new BrowserProvider((window as any).ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  return { provider, signer, address };
}

/**
 * Flujo de depósito de liquidez de un proveedor.
 * Requiere 2 firmas en MetaMask: una para aprobar el gasto (approve) y
 * otra para el depósito real — esto es estándar en ERC-20, no un error.
 */
export async function depositLiquidity(amountHuman: string) {
  const { signer, address } = await connectWallet();
  const usdt = new Contract(USDT_ADDRESS, ERC20_ABI, signer);
  const escrow = new Contract(ESCROW_ADDRESS, ESCROW_ABI, signer);

  const decimals = await usdt.decimals();
  const amount = parseUnits(amountHuman, decimals);

  const approveTx = await usdt.approve(ESCROW_ADDRESS, amount);
  await approveTx.wait();

  const depositTx = await escrow.depositLiquidity(amount);
  const receipt = await depositTx.wait();

  return { address, txHash: receipt.hash };
}

/**
 * El proveedor libera los fondos al cliente. Esta es la llamada que
 * dispara el popup de MetaMask pidiendo confirmación — tal como lo
 * describiste: "completar" en la app llama a esto, y MetaMask pregunta
 * si de verdad quiere liberar los fondos.
 */
export async function releaseFundsToClient(operationId: string) {
  const { signer } = await connectWallet();
  const escrow = new Contract(ESCROW_ADDRESS, ESCROW_ABI, signer);

  // El operationId de tu base de datos (uuid) se convierte a bytes32
  // determinístico para que coincida con el que usó el backend al bloquear.
  const operationIdBytes32 = uuidToBytes32(operationId);

  const tx = await escrow.releaseToClient(operationIdBytes32);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

export async function markOperationDisputed(operationId: string) {
  const { signer } = await connectWallet();
  const escrow = new Contract(ESCROW_ADDRESS, ESCROW_ABI, signer);
  const tx = await escrow.markDisputed(uuidToBytes32(operationId));
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

export async function getAvailableLiquidity(providerAddress: string) {
  const { signer } = await connectWallet();
  const escrow = new Contract(ESCROW_ADDRESS, ESCROW_ABI, signer);
  const raw = await escrow.availableLiquidity(providerAddress);
  return formatUnits(raw, 6); // USDT = 6 decimales
}

/**
 * Convierte un UUID (formato de tu tabla `operations`) a bytes32 de forma
 * determinística, para usarlo como operationId dentro del contrato.
 */
function uuidToBytes32(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  return "0x" + hex.padEnd(64, "0");
}
