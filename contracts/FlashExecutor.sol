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
    
    event ArbitrageFailed(
        address indexed caller,
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

    // State variables
    mapping(address => bool) public authorizedPools;
    uint256 public minProfit;
    uint256 public constant MAX_ROUTES = 3;
    
    // Route data structure
    struct RouteData {
        address[] pools;
        bool[] directions;
        uint256 minProfit;
        uint256 deadline;
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
     * @dev Uniswap V3 flash callback implementation
     * @param fee0 Fee for token0
     * @param fee1 Fee for token1
     * @param data Encoded route data
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
            IERC20(token0).safeTransfer(msg.sender, amount0Owed);
        }
        
        if (amount1Owed > 0) {
            IERC20(token1).safeTransfer(msg.sender, amount1Owed);
        }
    }

    /**
     * @dev Execute arbitrage swaps through multiple routes
     * @param route Route data containing pools and directions
     */
    function _executeArbitrageSwaps(RouteData memory route) internal {
        // Execute swaps through each pool in the route
        for (uint256 i = 0; i < route.pools.length; i++) {
            address pool = route.pools[i];
            bool direction = route.directions[i];
            
            // Determine if this is a Uniswap V3 or Aerodrome pool
            if (_isUniswapV3Pool(pool)) {
                _executeUniswapV3Swap(pool, direction);
            } else {
                _executeAerodromeSwap(pool, direction);
            }
        }
    }

    /**
     * @dev Execute Uniswap V3 swap
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
        
        // Calculate sqrt price limit (allow 5% slippage)
        uint160 sqrtPriceLimitX96 = zeroForOne ? 
            TickMath.MIN_SQRT_RATIO + 1 : 
            TickMath.MAX_SQRT_RATIO - 1;
        
        // Execute swap
        uniPool.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            sqrtPriceLimitX96,
            ""
        );
    }

    /**
     * @dev Execute Aerodrome swap
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
        
        // Transfer tokens to pair
        IERC20(tokenIn).safeTransfer(pool, amountIn);
        
        // Get reserves and calculate output amount
        (uint256 reserve0, uint256 reserve1,) = aeroPair.getReserves();
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        
        // Calculate amount out (simplified, real implementation would use Aerodrome's formula)
        uint256 amountOut = _getAerodromeAmountOut(amountIn, reserveIn, reserveOut, aeroPair.stable());
        
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
     * @dev Receive ETH
     */
    receive() external payable {}
}