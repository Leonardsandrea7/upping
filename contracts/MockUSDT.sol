// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDT
 * @notice Token de prueba SOLO para testnet. Cualquiera puede acuñar (mint)
 * tokens gratis para simular tener USDT y probar el flujo completo de
 * UppingEscrow sin arriesgar dinero real.
 *
 * NUNCA desplegar esto en mainnet — en mainnet se usa el USDT/USDC real.
 */
contract MockUSDT is ERC20 {
    constructor() ERC20("Mock USDT", "mUSDT") {}

    /// @notice Cualquiera puede acuñar tokens de prueba para sí mismo.
    function faucet(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6; // USDT real usa 6 decimales
    }
}
