// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Uniswap V3 interfaces
interface IUniswapV3Pool {
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;
    
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

// Aerodrome interfaces
interface IAerodromePair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;
}

// Lending protocol interfaces for liquidations
interface IMoonwellComptroller {
    function liquidateBorrow(
        address borrower,
        uint256 repayAmount,
        address cTokenCollateral
    ) external returns (uint256);
}

interface IAaveV3Pool {
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

interface ISeamlessPool {
    function liquidate(
        address borrower,
        address collateralAsset,
        address debtAsset,
        uint256 debtAmount
    ) external returns (uint256);
}

// Uniswap V3 tick math library (simplified)
library TickMath {
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
}

/**
 * @title FlashExecutor
 * @dev Flash-loan-native MEV executor for Base blockchain
 * Implements IUniswapV3FlashCallback for flash loan arbitrage execution
 */
contract FlashExecutor is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // Events
    event ArbitrageExecuted(
        address indexed caller,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 profit,
        uint256 gasUsed
    );
    
    event LiquidationExecuted(
        address indexed caller,
        address indexed borrower,
        address indexed protocol,
        address collateralAsset,
        address debtAsset,
        uint256 debtAmount,
        uint256 collateralReceived,
        uint256 profit,
        uint256 gasUsed
    );
    
    event ArbitrageFailed(
        address indexed caller,
        string reason,
        uint256 gasUsed
    );
    
    event LiquidationFailed(
        address indexed caller,
        address indexed borrower,
        string reason,
        uint256 gasUsed
    );
    
    event UnauthorizedCallback(
        address indexed caller,
        address indexed pool
    );
    
    event InsufficientProfit(
        uint256 actualProfit,
        uint256 minProfit
    );
    
    event PauseStateChanged(
        bool isPaused,
        address indexed caller
    );
    
    event PoolAuthorizationChanged(
        address indexed pool,
        bool isAuthorized
    );

    // Custom errors
    error UnauthorizedCallback();
    error InsufficientRepayment(uint256 required, uint256 available);
    error AllRoutesFailed();
    error InsufficientProfit(uint256 actual, uint256 minimum);
    error SlippageExceeded(uint256 expected, uint256 actual);
    error DeadlineExceeded();
    error InvalidRoute();
    error ContractPaused();
    error LiquidationFailed(string reason);
    error UnsupportedProtocol(string protocol);
    error InvalidLiquidationData();

    // State variables
    mapping(address => bool) public authorizedPools;
    mapping(address => bool) public authorizedProtocols;
    uint256 public minProfit;
    uint256 public constant MAX_ROUTES = 3;
    
    // Route data structure
    struct RouteData {
        address[] pools;
        bool[] directions;
        uint256 minProfit;
        uint256 deadline;
    }

    // Liquidation data structure
    struct LiquidationData {
        string protocol; // "moonwell", "aave_v3", "seamless"
        address borrower;
        address protocolAddress;
        address collateralAsset;
        address debtAsset;
        uint256 debtAmount;
        uint256 minProfit;
        uint256 deadline;
        address[] swapRoute; // Route to convert collateral to debt asset
    }

    constructor(uint256 _minProfit) {
        minProfit = _minProfit;
    }

    /**
     * @dev Execute arbitrage using Uniswap V3 flash loan
     * @param flashPool The Uniswap V3 pool to flash loan from
     * @param amount0 Amount of token0 to flash loan
     * @param amount1 Amount of token1 to flash loan
     * @param routeData Encoded route data for arbitrage execution
     */
    function executeArbitrage(
        address flashPool,
        uint256 amount0,
        uint256 amount1,
        bytes calldata routeData
    ) external nonReentrant whenNotPaused {
        if (!authorizedPools[flashPool]) {
            revert UnauthorizedCallback();
        }

        // Decode route data
        RouteData memory route = abi.decode(routeData, (RouteData));
        
        // Validate route
        if (route.pools.length == 0 || route.pools.length > MAX_ROUTES) {
            revert InvalidRoute();
        }
        
        if (block.timestamp > route.deadline) {
            revert DeadlineExceeded();
        }

        // Store initial balance for profit calculation
        uint256 initialBalance = address(this).balance;
        
        // Store borrowed amounts for repayment calculation
        uint256 borrowedAmount0 = amount0;
        uint256 borrowedAmount1 = amount1;
        
        // Encode borrowed amounts with route data for callback
        bytes memory callbackData = abi.encode(route, borrowedAmount0, borrowedAmount1);
        
        // Initiate flash loan
        IUniswapV3Pool(flashPool).flash(
            address(this),
            amount0,
            amount1,
            callbackData
        );
        
        // Calculate actual profit
        uint256 finalBalance = address(this).balance;
        uint256 actualProfit = finalBalance > initialBalance ? 
            finalBalance - initialBalance : 0;
        
        // Validate minimum profit
        if (actualProfit < route.minProfit || actualProfit < minProfit) {
            revert InsufficientProfit(actualProfit, route.minProfit);
        }

        emit ArbitrageExecuted(
            msg.sender,
            address(0), // Will be set in callback
            address(0), // Will be set in callback
            amount0 + amount1,
            actualProfit,
            gasleft()
        );
    }

    /**
     * @dev Execute liquidation using Uniswap V3 flash loan
     * @param flashPool The Uniswap V3 pool to flash loan from
     * @param amount0 Amount of token0 to flash loan
     * @param amount1 Amount of token1 to flash loan
     * @param liquidationData Encoded liquidation data
     */
    function executeLiquidation(
        address flashPool,
        uint256 amount0,
        uint256 amount1,
        bytes calldata liquidationData
    ) external nonReentrant whenNotPaused {
        if (!authorizedPools[flashPool]) {
            revert UnauthorizedCallback();
        }

        // Decode liquidation data
        LiquidationData memory liquidation = abi.decode(liquidationData, (LiquidationData));
        
        // Validate liquidation data
        if (bytes(liquidation.protocol).length == 0 || liquidation.borrower == address(0)) {
            revert InvalidLiquidationData();
        }
        
        if (!authorizedProtocols[liquidation.protocolAddress]) {
            revert UnsupportedProtocol(liquidation.protocol);
        }
        
        if (block.timestamp > liquidation.deadline) {
            revert DeadlineExceeded();
        }

        // Store initial balance for profit calculation
        uint256 initialBalance = address(this).balance;
        
        // Store borrowed amounts for repayment calculation
        uint256 borrowedAmount0 = amount0;
        uint256 borrowedAmount1 = amount1;
        
        // Encode borrowed amounts with liquidation data for callback
        bytes memory callbackData = abi.encode(liquidation, borrowedAmount0, borrowedAmount1, "liquidation");
        
        // Initiate flash loan
        IUniswapV3Pool(flashPool).flash(
            address(this),
            amount0,
            amount1,
            callbackData
        );
        
        // Calculate actual profit
        uint256 finalBalance = address(this).balance;
        uint256 actualProfit = finalBalance > initialBalance ? 
            finalBalance - initialBalance : 0;
        
        // Validate minimum profit
        if (actualProfit < liquidation.minProfit || actualProfit < minProfit) {
            revert InsufficientProfit(actualProfit, liquidation.minProfit);
        }

        emit LiquidationExecuted(
            msg.sender,
            liquidation.borrower,
            liquidation.protocolAddress,
            liquidation.collateralAsset,
            liquidation.debtAsset,
            liquidation.debtAmount,
            0, // Will be calculated in callback
            actualProfit,
            gasleft()
        );
    }

    /**
     * @dev Uniswap V3 flash callback implementation
     * @param fee0 Fee for token0
     * @param fee1 Fee for token1
     * @param data Encoded route or liquidation data
     */
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external {
        // Verify callback is from authorized pool
        if (!authorizedPools[msg.sender]) {
            emit UnauthorizedCallback(tx.origin, msg.sender);
            revert UnauthorizedCallback();
        }

        // Check if this is arbitrage or liquidation
        // Try to decode as liquidation first (has operation type marker)
        try this._handleLiquidationCallback(fee0, fee1, data) {
            return;
        } catch {
            // Fall back to arbitrage callback
            _handleArbitrageCallback(fee0, fee1, data);
        }
    }

    /**
     * @dev Handle liquidation callback (external for try/catch)
     */
    function _handleLiquidationCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external {
        require(msg.sender == address(this), "Only self-call allowed");
        
        // Decode liquidation data
        (LiquidationData memory liquidation, uint256 borrowedAmount0, uint256 borrowedAmount1, string memory operationType) = 
            abi.decode(data, (LiquidationData, uint256, uint256, string));
        
        // Verify this is a liquidation operation
        if (keccak256(bytes(operationType)) != keccak256(bytes("liquidation"))) {
            revert InvalidLiquidationData();
        }
        
        // Execute liquidation
        _executeLiquidation(liquidation, fee0, fee1, borrowedAmount0, borrowedAmount1);
    }

    /**
     * @dev Handle arbitrage callback
     */
    function _handleArbitrageCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) internal {
        // Decode route data and borrowed amounts
        (RouteData memory route, uint256 borrowedAmount0, uint256 borrowedAmount1) = 
            abi.decode(data, (RouteData, uint256, uint256));
        
        // Store initial balances for profit calculation
        address token0 = IUniswapV3Pool(msg.sender).token0();
        address token1 = IUniswapV3Pool(msg.sender).token1();
        
        uint256 initialBalance0 = IERC20(token0).balanceOf(address(this));
        uint256 initialBalance1 = IERC20(token1).balanceOf(address(this));
        
        // Execute arbitrage swaps
        _executeArbitrageSwaps(route);
        
        // Calculate final balances
        uint256 finalBalance0 = IERC20(token0).balanceOf(address(this));
        uint256 finalBalance1 = IERC20(token1).balanceOf(address(this));
        
        // Calculate repayment amounts (borrowed amount + fees)
        uint256 amount0Owed = borrowedAmount0 + fee0;
        uint256 amount1Owed = borrowedAmount1 + fee1;
        
        // Ensure we have enough to repay
        if (finalBalance0 < amount0Owed) {
            revert InsufficientRepayment(amount0Owed, finalBalance0);
        }
        if (finalBalance1 < amount1Owed) {
            revert InsufficientRepayment(amount1Owed, finalBalance1);
        }
        
        // Calculate profit after repayment
        uint256 profit0 = finalBalance0 - amount0Owed - initialBalance0;
        uint256 profit1 = finalBalance1 - amount1Owed - initialBalance1;
        
        // Validate minimum profit (simplified - real implementation would convert to USD)
        uint256 totalProfit = profit0 + profit1; // Simplified calculation
        if (totalProfit < route.minProfit) {
            revert InsufficientProfit(totalProfit, route.minProfit);
        }
        
        // Repay flash loan
        if (amount0Owed > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token0()).safeTransfer(msg.sender, amount0Owed);
        }
        
        if (amount1Owed > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token1()).safeTransfer(msg.sender, amount1Owed);
        }
    }

    /**
     * @dev Execute liquidation with flash loan
     * @param liquidation Liquidation data
     * @param fee0 Flash loan fee for token0
     * @param fee1 Flash loan fee for token1
     * @param borrowedAmount0 Borrowed amount of token0
     * @param borrowedAmount1 Borrowed amount of token1
     */
    function _executeLiquidation(
        LiquidationData memory liquidation,
        uint256 fee0,
        uint256 fee1,
        uint256 borrowedAmount0,
        uint256 borrowedAmount1
    ) internal {
        // Get flash loan pool tokens
        address token0 = IUniswapV3Pool(msg.sender).token0();
        address token1 = IUniswapV3Pool(msg.sender).token1();
        
        // Store initial balances
        uint256 initialBalance0 = IERC20(token0).balanceOf(address(this));
        uint256 initialBalance1 = IERC20(token1).balanceOf(address(this));
        
        // Determine which token is the debt asset
        address debtToken = liquidation.debtAsset;
        uint256 debtAmount = liquidation.debtAmount;
        
        // Ensure we have the debt token from flash loan
        require(debtToken == token0 || debtToken == token1, "Debt token not in flash loan");
        
        // Execute protocol-specific liquidation
        uint256 collateralReceived = _executeProtocolLiquidation(liquidation);
        
        // If collateral asset is different from debt asset, swap it
        if (liquidation.collateralAsset != liquidation.debtAsset) {
            _swapCollateralToDebt(
                liquidation.collateralAsset,
                liquidation.debtAsset,
                collateralReceived,
                liquidation.swapRoute
            );
        }
        
        // Calculate final balances
        uint256 finalBalance0 = IERC20(token0).balanceOf(address(this));
        uint256 finalBalance1 = IERC20(token1).balanceOf(address(this));
        
        // Calculate repayment amounts
        uint256 amount0Owed = borrowedAmount0 + fee0;
        uint256 amount1Owed = borrowedAmount1 + fee1;
        
        // Ensure we have enough to repay
        if (finalBalance0 < amount0Owed) {
            revert InsufficientRepayment(amount0Owed, finalBalance0);
        }
        if (finalBalance1 < amount1Owed) {
            revert InsufficientRepayment(amount1Owed, finalBalance1);
        }
        
        // Calculate profit after repayment
        uint256 profit0 = finalBalance0 - amount0Owed - initialBalance0;
        uint256 profit1 = finalBalance1 - amount1Owed - initialBalance1;
        uint256 totalProfit = profit0 + profit1;
        
        // Validate minimum profit
        if (totalProfit < liquidation.minProfit) {
            revert InsufficientProfit(totalProfit, liquidation.minProfit);
        }
        
        // Repay flash loan
        if (amount0Owed > 0) {
            IERC20(token0).safeTransfer(msg.sender, amount0Owed);
        }
        if (amount1Owed > 0) {
            IERC20(token1).safeTransfer(msg.sender, amount1Owed);
        }
    }

    /**
     * @dev Execute protocol-specific liquidation
     * @param liquidation Liquidation data
     * @return collateralReceived Amount of collateral received
     */
    function _executeProtocolLiquidation(
        LiquidationData memory liquidation
    ) internal returns (uint256 collateralReceived) {
        bytes32 protocolHash = keccak256(bytes(liquidation.protocol));
        
        if (protocolHash == keccak256(bytes("moonwell"))) {
            collateralReceived = _executeMoonwellLiquidation(liquidation);
        } else if (protocolHash == keccak256(bytes("aave_v3"))) {
            collateralReceived = _executeAaveV3Liquidation(liquidation);
        } else if (protocolHash == keccak256(bytes("seamless"))) {
            collateralReceived = _executeSeamlessLiquidation(liquidation);
        } else {
            revert UnsupportedProtocol(liquidation.protocol);
        }
    }

    /**
     * @dev Execute Moonwell liquidation
     */
    function _executeMoonwellLiquidation(
        LiquidationData memory liquidation
    ) internal returns (uint256 collateralReceived) {
        // Approve debt token for liquidation
        IERC20(liquidation.debtAsset).safeApprove(liquidation.protocolAddress, liquidation.debtAmount);
        
        // Get initial collateral balance
        uint256 initialCollateralBalance = IERC20(liquidation.collateralAsset).balanceOf(address(this));
        
        // Execute Moonwell liquidation
        IMoonwellComptroller(liquidation.protocolAddress).liquidateBorrow(
            liquidation.borrower,
            liquidation.debtAmount,
            liquidation.collateralAsset // cToken address
        );
        
        // Calculate collateral received
        uint256 finalCollateralBalance = IERC20(liquidation.collateralAsset).balanceOf(address(this));
        collateralReceived = finalCollateralBalance - initialCollateralBalance;
        
        if (collateralReceived == 0) {
            revert LiquidationFailed("No collateral received from Moonwell");
        }
    }

    /**
     * @dev Execute Aave V3 liquidation
     */
    function _executeAaveV3Liquidation(
        LiquidationData memory liquidation
    ) internal returns (uint256 collateralReceived) {
        // Approve debt token for liquidation
        IERC20(liquidation.debtAsset).safeApprove(liquidation.protocolAddress, liquidation.debtAmount);
        
        // Get initial collateral balance
        uint256 initialCollateralBalance = IERC20(liquidation.collateralAsset).balanceOf(address(this));
        
        // Execute Aave V3 liquidation
        IAaveV3Pool(liquidation.protocolAddress).liquidationCall(
            liquidation.collateralAsset,
            liquidation.debtAsset,
            liquidation.borrower,
            liquidation.debtAmount,
            false // Don't receive aTokens
        );
        
        // Calculate collateral received
        uint256 finalCollateralBalance = IERC20(liquidation.collateralAsset).balanceOf(address(this));
        collateralReceived = finalCollateralBalance - initialCollateralBalance;
        
        if (collateralReceived == 0) {
            revert LiquidationFailed("No collateral received from Aave V3");
        }
    }

    /**
     * @dev Execute Seamless liquidation
     */
    function _executeSeamlessLiquidation(
        LiquidationData memory liquidation
    ) internal returns (uint256 collateralReceived) {
        // Approve debt token for liquidation
        IERC20(liquidation.debtAsset).safeApprove(liquidation.protocolAddress, liquidation.debtAmount);
        
        // Get initial collateral balance
        uint256 initialCollateralBalance = IERC20(liquidation.collateralAsset).balanceOf(address(this));
        
        // Execute Seamless liquidation
        collateralReceived = ISeamlessPool(liquidation.protocolAddress).liquidate(
            liquidation.borrower,
            liquidation.collateralAsset,
            liquidation.debtAsset,
            liquidation.debtAmount
        );
        
        if (collateralReceived == 0) {
            revert LiquidationFailed("No collateral received from Seamless");
        }
    }

    /**
     * @dev Swap collateral to debt asset using optimal route
     * @param collateralAsset Collateral token address
     * @param debtAsset Debt token address
     * @param collateralAmount Amount of collateral to swap
     * @param swapRoute Array of pool addresses for optimal route
     */
    function _swapCollateralToDebt(
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        address[] memory swapRoute
    ) internal {
        if (swapRoute.length == 0) {
            revert InvalidRoute();
        }
        
        uint256 currentAmount = collateralAmount;
        address currentToken = collateralAsset;
        
        // Execute swaps through the route
        for (uint256 i = 0; i < swapRoute.length; i++) {
            address pool = swapRoute[i];
            
            if (_isUniswapV3Pool(pool)) {
                currentAmount = _swapThroughUniswapV3(pool, currentToken, currentAmount);
            } else {
                currentAmount = _swapThroughAerodrome(pool, currentToken, currentAmount);
            }
            
            // Update current token for next iteration
            if (i < swapRoute.length - 1) {
                // Determine output token for next swap
                if (_isUniswapV3Pool(pool)) {
                    IUniswapV3Pool uniPool = IUniswapV3Pool(pool);
                    currentToken = (currentToken == uniPool.token0()) ? uniPool.token1() : uniPool.token0();
                } else {
                    IAerodromePair aeroPair = IAerodromePair(pool);
                    currentToken = (currentToken == aeroPair.token0()) ? aeroPair.token1() : aeroPair.token0();
                }
            }
        }
        
        // Verify we ended up with the debt asset
        require(currentToken == debtAsset, "Swap route did not end with debt asset");
    }

    /**
     * @dev Swap through Uniswap V3 pool
     */
    function _swapThroughUniswapV3(
        address pool,
        address tokenIn,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        IUniswapV3Pool uniPool = IUniswapV3Pool(pool);
        
        bool zeroForOne = tokenIn == uniPool.token0();
        
        // Calculate sqrt price limit (allow 5% slippage)
        uint160 sqrtPriceLimitX96 = zeroForOne ? 
            TickMath.MIN_SQRT_RATIO + 1 : 
            TickMath.MAX_SQRT_RATIO - 1;
        
        // Get initial balance of output token
        address tokenOut = zeroForOne ? uniPool.token1() : uniPool.token0();
        uint256 initialBalance = IERC20(tokenOut).balanceOf(address(this));
        
        // Execute swap
        uniPool.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            sqrtPriceLimitX96,
            ""
        );
        
        // Calculate amount received
        uint256 finalBalance = IERC20(tokenOut).balanceOf(address(this));
        amountOut = finalBalance - initialBalance;
    }

    /**
     * @dev Swap through Aerodrome pool
     */
    function _swapThroughAerodrome(
        address pool,
        address tokenIn,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        IAerodromePair aeroPair = IAerodromePair(pool);
        
        bool zeroForOne = tokenIn == aeroPair.token0();
        address tokenOut = zeroForOne ? aeroPair.token1() : aeroPair.token0();
        
        // Get initial balance of output token
        uint256 initialBalance = IERC20(tokenOut).balanceOf(address(this));
        
        // Transfer tokens to pair
        IERC20(tokenIn).safeTransfer(pool, amountIn);
        
        // Get reserves and calculate output amount
        (uint256 reserve0, uint256 reserve1,) = aeroPair.getReserves();
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        
        // Calculate amount out
        uint256 calculatedAmountOut = _getAerodromeAmountOut(amountIn, reserveIn, reserveOut, aeroPair.stable());
        
        // Execute swap
        if (zeroForOne) {
            aeroPair.swap(0, calculatedAmountOut, address(this), "");
        } else {
            aeroPair.swap(calculatedAmountOut, 0, address(this), "");
        }
        
        // Calculate actual amount received
        uint256 finalBalance = IERC20(tokenOut).balanceOf(address(this));
        amountOut = finalBalance - initialBalance;
    }

    /**
     * @dev Execute arbitrage swaps through multiple routes with fallback support
     * @param route Route data containing pools and directions
     */
    function _executeArbitrageSwaps(RouteData memory route) internal {
        uint256 routeIndex = 0;
        bool success = false;
        
        // Try primary route first, then fallback routes
        while (routeIndex < route.pools.length && !success) {
            try this._executeSingleRoute(route.pools[routeIndex], route.directions[routeIndex]) {
                success = true;
            } catch {
                routeIndex++;
                // If this was the last route, revert
                if (routeIndex >= route.pools.length) {
                    revert AllRoutesFailed();
                }
            }
        }
    }

    /**
     * @dev Execute a single route (external for try/catch)
     * @param pool Pool address
     * @param direction Swap direction
     */
    function _executeSingleRoute(address pool, bool direction) external {
        require(msg.sender == address(this), "Only self-call allowed");
        
        // Determine if this is a Uniswap V3 or Aerodrome pool
        if (_isUniswapV3Pool(pool)) {
            _executeUniswapV3Swap(pool, direction);
        } else {
            _executeAerodromeSwap(pool, direction);
        }
    }

    /**
     * @dev Execute Uniswap V3 swap with optimal amount calculation
     * @param pool Uniswap V3 pool address
     * @param zeroForOne Direction of swap (token0 -> token1 if true)
     */
    function _executeUniswapV3Swap(address pool, bool zeroForOne) internal {
        IUniswapV3Pool uniPool = IUniswapV3Pool(pool);
        
        // Get token addresses
        address token0 = uniPool.token0();
        address token1 = uniPool.token1();
        
        // Determine input/output tokens
        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;
        
        // Get available balance for swap
        uint256 amountIn = IERC20(tokenIn).balanceOf(address(this));
        require(amountIn > 0, "No tokens to swap");
        
        // Calculate optimal amount (use full balance for flash loan arbitrage)
        uint256 optimalAmountIn = _calculateOptimalAmount(amountIn, pool, zeroForOne);
        
        // Calculate sqrt price limit (allow 5% slippage)
        uint160 sqrtPriceLimitX96 = zeroForOne ? 
            TickMath.MIN_SQRT_RATIO + 1 : 
            TickMath.MAX_SQRT_RATIO - 1;
        
        // Execute swap with optimal amount
        uniPool.swap(
            address(this),
            zeroForOne,
            int256(optimalAmountIn),
            sqrtPriceLimitX96,
            ""
        );
    }

    /**
     * @dev Execute Aerodrome swap with optimal amount calculation
     * @param pool Aerodrome pool address
     * @param zeroForOne Direction of swap (token0 -> token1 if true)
     */
    function _executeAerodromeSwap(address pool, bool zeroForOne) internal {
        IAerodromePair aeroPair = IAerodromePair(pool);
        
        // Get token addresses
        address token0 = aeroPair.token0();
        address token1 = aeroPair.token1();
        
        // Determine input/output tokens
        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;
        
        // Get available balance for swap
        uint256 amountIn = IERC20(tokenIn).balanceOf(address(this));
        require(amountIn > 0, "No tokens to swap");
        
        // Calculate optimal amount (use full balance for flash loan arbitrage)
        uint256 optimalAmountIn = _calculateOptimalAerodromeAmount(amountIn, pool, zeroForOne);
        
        // Transfer optimal amount to pair
        IERC20(tokenIn).safeTransfer(pool, optimalAmountIn);
        
        // Get reserves and calculate output amount
        (uint256 reserve0, uint256 reserve1,) = aeroPair.getReserves();
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        
        // Calculate amount out using optimal amount
        uint256 amountOut = _getAerodromeAmountOut(optimalAmountIn, reserveIn, reserveOut, aeroPair.stable());
        
        // Execute swap
        if (zeroForOne) {
            aeroPair.swap(0, amountOut, address(this), "");
        } else {
            aeroPair.swap(amountOut, 0, address(this), "");
        }
    }

    /**
     * @dev Calculate Aerodrome output amount
     * @param amountIn Input amount
     * @param reserveIn Input token reserve
     * @param reserveOut Output token reserve
     * @param stable Whether the pool is stable or volatile
     * @return amountOut Output amount
     */
    function _getAerodromeAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        bool stable
    ) internal pure returns (uint256 amountOut) {
        if (stable) {
            // Stable pool formula (simplified)
            // Real implementation would use Aerodrome's stable swap math
            uint256 fee = 5; // 0.05% fee
            uint256 amountInWithFee = amountIn * (10000 - fee);
            amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee);
        } else {
            // Volatile pool formula (Uniswap V2 style)
            uint256 fee = 30; // 0.3% fee
            uint256 amountInWithFee = amountIn * (10000 - fee);
            amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee);
        }
    }

    /**
     * @dev Calculate optimal amount for Uniswap V3 swap
     * @param availableAmount Available token amount
     * @param pool Uniswap V3 pool address
     * @param zeroForOne Swap direction
     * @return optimalAmount Optimal amount to swap
     */
    function _calculateOptimalAmount(
        uint256 availableAmount,
        address pool,
        bool zeroForOne
    ) internal view returns (uint256 optimalAmount) {
        // For flash loan arbitrage, we typically want to use the full amount
        // In a more sophisticated implementation, this would calculate the optimal amount
        // based on price impact and slippage constraints
        optimalAmount = availableAmount;
        
        // Ensure we don't exceed maximum swap limits (if any)
        uint256 maxSwapAmount = availableAmount * 95 / 100; // 95% to account for fees
        if (optimalAmount > maxSwapAmount) {
            optimalAmount = maxSwapAmount;
        }
    }

    /**
     * @dev Calculate optimal amount for Aerodrome swap
     * @param availableAmount Available token amount
     * @param pool Aerodrome pool address
     * @param zeroForOne Swap direction
     * @return optimalAmount Optimal amount to swap
     */
    function _calculateOptimalAerodromeAmount(
        uint256 availableAmount,
        address pool,
        bool zeroForOne
    ) internal view returns (uint256 optimalAmount) {
        // For flash loan arbitrage, we typically want to use the full amount
        // In a more sophisticated implementation, this would calculate the optimal amount
        // based on the stable/volatile pool type and price impact
        optimalAmount = availableAmount;
        
        // Ensure we don't exceed maximum swap limits
        uint256 maxSwapAmount = availableAmount * 95 / 100; // 95% to account for fees
        if (optimalAmount > maxSwapAmount) {
            optimalAmount = maxSwapAmount;
        }
    }

    /**
     * @dev Check if pool is Uniswap V3 pool
     * @param pool Pool address to check
     * @return bool True if Uniswap V3 pool
     */
    function _isUniswapV3Pool(address pool) internal view returns (bool) {
        // Simple check - try to call Uniswap V3 specific function
        try IUniswapV3Pool(pool).fee() returns (uint24) {
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @dev Check if pool is authorized for flash loans
     * @param pool Pool address to check
     * @return bool True if authorized
     */
    function isAuthorizedPool(address pool) external view returns (bool) {
        return authorizedPools[pool];
    }

    /**
     * @dev Get minimum profit requirement
     * @return uint256 Minimum profit in wei
     */
    function getMinProfit() external view returns (uint256) {
        return minProfit;
    }

    /**
     * @dev Add authorized pool (admin only)
     * @param pool Pool address to authorize
     */
    function addAuthorizedPool(address pool) external onlyOwner {
        authorizedPools[pool] = true;
        emit PoolAuthorizationChanged(pool, true);
    }

    /**
     * @dev Remove authorized pool (admin only)
     * @param pool Pool address to remove
     */
    function removeAuthorizedPool(address pool) external onlyOwner {
        authorizedPools[pool] = false;
        emit PoolAuthorizationChanged(pool, false);
    }

    /**
     * @dev Set minimum profit requirement (admin only)
     * @param _minProfit New minimum profit in wei
     */
    function setMinProfit(uint256 _minProfit) external onlyOwner {
        minProfit = _minProfit;
    }

    /**
     * @dev Pause contract (admin only)
     */
    function pause() external onlyOwner {
        _pause();
        emit PauseStateChanged(true, msg.sender);
    }

    /**
     * @dev Unpause contract (admin only)
     */
    function unpause() external onlyOwner {
        _unpause();
        emit PauseStateChanged(false, msg.sender);
    }

    /**
     * @dev Emergency withdraw tokens (admin only)
     * @param token Token address to withdraw
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            payable(owner()).transfer(amount);
        } else {
            IERC20(token).safeTransfer(owner(), amount);
        }
    }

    /**
     * @dev Add authorized protocol (admin only)
     * @param protocol Protocol address to authorize
     */
    function addAuthorizedProtocol(address protocol) external onlyOwner {
        authorizedProtocols[protocol] = true;
    }

    /**
     * @dev Remove authorized protocol (admin only)
     * @param protocol Protocol address to remove
     */
    function removeAuthorizedProtocol(address protocol) external onlyOwner {
        authorizedProtocols[protocol] = false;
    }

    /**
     * @dev Check if protocol is authorized for liquidations
     * @param protocol Protocol address to check
     * @return bool True if authorized
     */
    function isAuthorizedProtocol(address protocol) external view returns (bool) {
        return authorizedProtocols[protocol];
    }

    /**
     * @dev Receive ETH
     */
    receive() external payable {}
}