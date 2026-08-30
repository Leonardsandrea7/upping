// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title UppingEscrow
 * @notice Contrato de escrow no-custodial para la pool de liquidez de Upping.
 *
 * Flujo:
 * 1. Un proveedor deposita USDT en el contrato (depositLiquidity).
 * 2. Al tomar una operación, se bloquea una porción de su liquidez (lockForOperation),
 *    llamado por el backend de Upping cuando el proveedor confirma tomar el trade.
 * 3. Cuando el proveedor confirma que el pago fiat llegó, llama releaseToClient,
 *    que transfiere el monto bloqueado al usuario y desbloquea el resto.
 * 4. Si hay disputa y Upping (arbitro) resuelve a favor del cliente, se llama
 *    a slashForDispute — el arbitro NO puede mover fondos salvo en este caso
 *    específico y con una operación real en disputa.
 *
 * IMPORTANTE — LEER ANTES DE DESPLEGAR CON DINERO REAL:
 * Este contrato NO ha sido auditado. Está pensado para desplegarse primero en
 * una testnet (Base Sepolia) y probarse exhaustivamente. No lo despliegues en
 * mainnet con fondos reales de terceros sin una auditoría de seguridad.
 */
contract UppingEscrow is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token; // USDT (o USDC) en Base

    // ============ COMISIÓN DE LA PLATAFORMA ============
    // El % que Upping se queda automáticamente en cada operación liberada.
    // En basis points: 100 = 1%, 250 = 2.5%, etc. Máximo razonable ~500 (5%).
    uint256 public platformFeeBps;
    address public treasury; // wallet de Upping que recibe la comisión

    struct Provider {
        uint256 totalDeposited;
        uint256 locked;
        bool active;
    }

    struct Operation {
        address provider;
        address client;
        uint256 amount;       // monto total bloqueado para esta operación
        uint256 feeAmount;    // comisión de Upping, calculada al bloquear
        bool resolved;
        bool disputed;
    }

    mapping(address => Provider) public providers;
    mapping(bytes32 => Operation) public operations; // operationId -> Operation

    // Dirección autorizada a resolver disputas (el arbitraje de Upping).
    // Separada del owner para poder rotarla sin tocar el resto del contrato.
    address public arbiter;

    event LiquidityDeposited(address indexed provider, uint256 amount);
    event LiquidityWithdrawn(address indexed provider, uint256 amount);
    event OperationLocked(bytes32 indexed operationId, address indexed provider, address indexed client, uint256 amount, uint256 feeAmount);
    event OperationReleased(bytes32 indexed operationId, address indexed provider, address indexed client, uint256 amountToClient, uint256 feeCollected);
    event OperationDisputed(bytes32 indexed operationId);
    event DisputeResolved(bytes32 indexed operationId, bool favorClient, uint256 amount);
    event ArbiterUpdated(address indexed newArbiter);
    event PlatformFeeUpdated(uint256 newFeeBps);
    event TreasuryUpdated(address indexed newTreasury);

    modifier onlyArbiter() {
        require(msg.sender == arbiter, "Solo el arbitro puede resolver disputas");
        _;
    }

    constructor(
        address tokenAddress,
        address arbiterAddress,
        address treasuryAddress,
        uint256 initialFeeBps
    ) Ownable(msg.sender) {
        require(tokenAddress != address(0), "Token invalido");
        require(arbiterAddress != address(0), "Arbitro invalido");
        require(treasuryAddress != address(0), "Tesoreria invalida");
        require(initialFeeBps <= 500, "Comision maxima 5%");
        token = IERC20(tokenAddress);
        arbiter = arbiterAddress;
        treasury = treasuryAddress;
        platformFeeBps = initialFeeBps;
    }

    /// @notice El proveedor deposita liquidez en el contrato desde su propia wallet.
    function depositLiquidity(uint256 amount) external nonReentrant {
        require(amount > 0, "Monto debe ser mayor a 0");
        token.safeTransferFrom(msg.sender, address(this), amount);

        Provider storage p = providers[msg.sender];
        p.totalDeposited += amount;
        p.active = true;

        emit LiquidityDeposited(msg.sender, amount);
    }

    /// @notice El proveedor retira liquidez NO bloqueada (disponible = totalDeposited - locked).
    function withdrawLiquidity(uint256 amount) external nonReentrant {
        Provider storage p = providers[msg.sender];
        uint256 available = p.totalDeposited - p.locked;
        require(amount <= available, "Excede liquidez disponible");

        p.totalDeposited -= amount;
        token.safeTransfer(msg.sender, amount);

        emit LiquidityWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Bloquea liquidez del proveedor para una operación específica.
     * @dev Llamado por el backend (owner) cuando el proveedor toma una operación
     * de la pool. En una versión posterior esto puede requerir firma del propio
     * proveedor (EIP-712) en vez de confiar en el backend — ver notas al final.
     */
    function lockForOperation(
        bytes32 operationId,
        address provider,
        address client,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(operations[operationId].amount == 0, "Operacion ya existe");
        Provider storage p = providers[provider];
        uint256 available = p.totalDeposited - p.locked;
        require(amount <= available, "Liquidez insuficiente del proveedor");

        p.locked += amount;
        uint256 fee = (amount * platformFeeBps) / 10000;
        operations[operationId] = Operation({
            provider: provider,
            client: client,
            amount: amount,
            feeAmount: fee,
            resolved: false,
            disputed: false
        });

        emit OperationLocked(operationId, provider, client, amount, fee);
    }

    /**
     * @notice El PROVEEDOR confirma que todo salió bien y libera los fondos al cliente.
     * Esta es la llamada que MetaMask le muestra al proveedor para firmar ("¿liberar fondos?").
     */
    function releaseToClient(bytes32 operationId) external nonReentrant {
        Operation storage op = operations[operationId];
        require(op.amount > 0, "Operacion no existe");
        require(!op.resolved, "Operacion ya resuelta");
        require(msg.sender == op.provider, "Solo el proveedor puede liberar");
        require(!op.disputed, "Operacion en disputa, solo el arbitro puede resolver");

        op.resolved = true;
        providers[op.provider].locked -= op.amount;
        providers[op.provider].totalDeposited -= op.amount;

        uint256 amountToClient = op.amount - op.feeAmount;

        // Aquí es exactamente donde Upping se queda con su comisión —
        // automático, en la misma transacción, sin intervención manual.
        if (op.feeAmount > 0) {
            token.safeTransfer(treasury, op.feeAmount);
        }
        token.safeTransfer(op.client, amountToClient);

        emit OperationReleased(operationId, op.provider, op.client, amountToClient, op.feeAmount);
    }

    /// @notice Cualquiera de las dos partes puede marcar una operación en disputa.
    /// Esto congela releaseToClient hasta que el arbitro resuelva.
    function markDisputed(bytes32 operationId) external {
        Operation storage op = operations[operationId];
        require(op.amount > 0, "Operacion no existe");
        require(!op.resolved, "Operacion ya resuelta");
        require(msg.sender == op.provider || msg.sender == op.client, "No autorizado");

        op.disputed = true;
        emit OperationDisputed(operationId);
    }

    /**
     * @notice El arbitro (Upping) resuelve una disputa.
     * @param favorClient true = el cliente tenía razón, se le transfiere el monto bloqueado.
     *                    false = el proveedor tenía razón, se le desbloquea su propio dinero.
     */
    function resolveDispute(bytes32 operationId, bool favorClient) external onlyArbiter nonReentrant {
        Operation storage op = operations[operationId];
        require(op.amount > 0, "Operacion no existe");
        require(!op.resolved, "Operacion ya resuelta");
        require(op.disputed, "Operacion no esta en disputa");

        op.resolved = true;
        providers[op.provider].locked -= op.amount;

        if (favorClient) {
            providers[op.provider].totalDeposited -= op.amount;
            token.safeTransfer(op.client, op.amount);
        }
        // Si favorClient es false, el monto simplemente se desbloquea
        // (sigue siendo parte de totalDeposited del proveedor, disponible de nuevo).

        emit DisputeResolved(operationId, favorClient, op.amount);
    }

    function setArbiter(address newArbiter) external onlyOwner {
        require(newArbiter != address(0), "Arbitro invalido");
        arbiter = newArbiter;
        emit ArbiterUpdated(newArbiter);
    }

    /// @notice Cambia el % de comisión (basis points). Solo afecta operaciones NUEVAS
    /// — las que ya están bloqueadas mantienen la comisión con la que se crearon.
    function setPlatformFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 500, "Comision maxima 5%");
        platformFeeBps = newFeeBps;
        emit PlatformFeeUpdated(newFeeBps);
    }

    /// @notice Cambia la wallet que recibe la comisión de Upping.
    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Tesoreria invalida");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function availableLiquidity(address provider) external view returns (uint256) {
        Provider memory p = providers[provider];
        return p.totalDeposited - p.locked;
    }

    /*
     * NOTAS PARA LA SIGUIENTE ITERACIÓN (no implementado todavía, a propósito):
     *
     * 1. lockForOperation hoy confía en el backend (onlyOwner) para bloquear
     *    fondos del proveedor. Esto significa que, técnicamente, el backend
     *    (tú) SÍ podría bloquear fondos sin acción directa del proveedor en
     *    esa wallet. Para el modelo "MetaMask pregunta y el proveedor firma"
     *    que describiste, la versión más segura es que el proveedor firme un
     *    mensaje EIP-712 aceptando la operación, y el contrato verifique esa
     *    firma en lockForOperation en vez de confiar en onlyOwner. Lo dejamos
     *    fuera de este MVP para no complicar la primera versión, pero es la
     *    mejora de seguridad más importante antes de mainnet.
     *
     * 2. No hay límite de tiempo (timeout) para una operación bloqueada. Si
     *    un proveedor nunca confirma ni se abre disputa, el dinero queda
     *    bloqueado indefinidamente. Vale la pena añadir un plazo tras el cual
     *    el cliente pueda reclamar automáticamente o forzar una disputa.
     *
     * 3. Este contrato no ha sido auditado. Antes de mainnet: pruebas
     *    exhaustivas en testnet, y considerar una auditoría externa dado que
     *    manejará fondos reales de terceros.
     */
}
