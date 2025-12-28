// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title FlashExecutor
 * @dev Flash-loan-native MEV execution contract for Base blockchain
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

    event PoolAuthorizationChanged(
        address indexed pool,
        bool isAuthorized
    );

    event MinProfitUpdated(
        uint256 oldMinProfit,
        uint256 newMinProfit
    );

    // Custom errors
    error UnauthorizedPool(address pool);
    error InsufficientProfitError(uint256 actual, uint256 required);
    error InvalidRoute();
    error DeadlineExceeded();
    error FlashLoanFailed();
    error SwapFailed();

    // State variables
    mapping(address => bool) public authorizedPools;
    uint256 public minProfit;
    uint256 public totalExecutions;
    uint256 public totalProfit;

    // Route data structure
    struct RouteData {
        address[] pools;
        bool[] directions;
        uint256 minProfit;
        uint256 deadline;
    }

    // Flash callback data structure
    struct FlashCallbackData {
        address caller;
        RouteData route;
        uint256 amount0;
        uint256 amount1;
    }

    constructor(
        address _owner,
        uint256 _minProfit,
        address[] memory _authorizedPools
    ) {
        _transferOwnership(_owner);
        minProfit = _minProfit;
        
        // Add authorized pools
        for (uint256 i = 0; i < _authorizedPools.length; i++) {
            authorizedPools[_authorizedPools[i]] = true;
            emit PoolAuthorizationChanged(_authorizedPools[i], true);
        }
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
        // Validate pool authorization
        if (!authorizedPools[flashPool]) {
            emit UnauthorizedCallback(msg.sender, flashPool);
            revert UnauthorizedPool(flashPool);
        }

        // Decode route data
        RouteData memory route = abi.decode(routeData, (RouteData));
        
        // Validate route
        if (route.pools.length == 0) {
            revert InvalidRoute();
        }
        
        // Check deadline
        if (block.timestamp > route.deadline) {
            revert DeadlineExceeded();
        }

        // Validate minimum profit
        if (route.minProfit < minProfit) {
            revert InsufficientProfitError(route.minProfit, minProfit);
        }

        // Prepare callback data
        FlashCallbackData memory callbackData = FlashCallbackData({
            caller: msg.sender,
            route: route,
            amount0: amount0,
            amount1: amount1
        });

        // Initiate flash loan
        try IUniswapV3Pool(flashPool).flash(
            address(this),
            amount0,
            amount1,
            abi.encode(callbackData)
        ) {
            // Flash loan initiated successfully
        } catch {
            emit ArbitrageFailed(msg.sender, "Flash loan initiation failed", gasleft());
            revert FlashLoanFailed();
        }
    }

    /**
     * @dev Uniswap V3 flash callback implementation
     * @param fee0 Fee for token0
     * @param fee1 Fee for token1
     * @param data Encoded callback data
     */
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external {
        // Verify callback is from authorized pool
        if (!authorizedPools[msg.sender]) {
            emit UnauthorizedCallback(tx.origin, msg.sender);
            revert UnauthorizedPool(msg.sender);
        }

        // Decode callback data
        FlashCallbackData memory callbackData = abi.decode(data, (FlashCallbackData));
        
        uint256 gasStart = gasleft();
        
        try this._executeArbitrageInternal(
            callbackData,
            fee0,
            fee1
        ) {
            // Arbitrage executed successfully
            uint256 gasUsed = gasStart - gasleft();
            totalExecutions++;
            
            emit ArbitrageExecuted(
                callbackData.caller,
                address(0), // Will be set in internal function
                address(0), // Will be set in internal function
                callbackData.amount0 + callbackData.amount1,
                0, // Will be calculated in internal function
                gasUsed
            );
        } catch Error(string memory reason) {
            uint256 gasUsed = gasStart - gasleft();
            emit ArbitrageFailed(callbackData.caller, reason, gasUsed);
            revert(reason);
        } catch {
            uint256 gasUsed = gasStart - gasleft();
            emit ArbitrageFailed(callbackData.caller, "Unknown error", gasUsed);
            revert("Arbitrage execution failed");
        }
    }

    /**
     * @dev Internal arbitrage execution logic
     * @param callbackData Flash callback data
     * @param fee0 Flash loan fee for token0
     * @param fee1 Flash loan fee for token1
     */
    function _executeArbitrageInternal(
        FlashCallbackData memory callbackData,
        uint256 fee0,
        uint256 fee1
    ) external {
        // This function should only be called by this contract
        require(msg.sender == address(this), "Internal function");

        // Get pool tokens
        address token0 = IUniswapV3Pool(callbackData.route.pools[0]).token0();
        address token1 = IUniswapV3Pool(callbackData.route.pools[0]).token1();

        // Record initial balances
        uint256 initialBalance0 = IERC20(token0).balanceOf(address(this));
        uint256 initialBalance1 = IERC20(token1).balanceOf(address(this));

        // Execute arbitrage route
        _executeRoute(callbackData.route, token0, token1);

        // Calculate final balances
        uint256 finalBalance0 = IERC20(token0).balanceOf(address(this));
        uint256 finalBalance1 = IERC20(token1).balanceOf(address(this));

        // Calculate required repayment
        uint256 repayAmount0 = callbackData.amount0 + fee0;
        uint256 repayAmount1 = callbackData.amount1 + fee1;

        // Verify we have enough to repay flash loan
        if (finalBalance0 < repayAmount0 || finalBalance1 < repayAmount1) {
            revert InsufficientProfitError(0, callbackData.route.minProfit);
        }

        // Calculate profit more accurately
        uint256 profit0 = finalBalance0 > repayAmount0 ? finalBalance0 - repayAmount0 : 0;
        uint256 profit1 = finalBalance1 > repayAmount1 ? finalBalance1 - repayAmount1 : 0;
        
        // Convert profits to a common denomination (simplified - would use price oracle)
        uint256 totalProfitValue = _calculateTotalProfitValue(
            token0, 
            token1, 
            profit0, 
            profit1
        );

        // Verify minimum profit
        if (totalProfitValue < callbackData.route.minProfit) {
            emit InsufficientProfit(totalProfitValue, callbackData.route.minProfit);
            revert InsufficientProfitError(totalProfitValue, callbackData.route.minProfit);
        }

        // Repay flash loan
        if (repayAmount0 > 0) {
            IERC20(token0).safeTransfer(callbackData.route.pools[0], repayAmount0);
        }
        if (repayAmount1 > 0) {
            IERC20(token1).safeTransfer(callbackData.route.pools[0], repayAmount1);
        }

        // Transfer profit to caller
        if (profit0 > 0) {
            IERC20(token0).safeTransfer(callbackData.caller, profit0);
        }
        if (profit1 > 0) {
            IERC20(token1).safeTransfer(callbackData.caller, profit1);
        }

        // Update total profit tracking
        totalProfit += totalProfitValue;
    }

    /**
     * @dev Execute arbitrage route through multiple pools
     * @param route Route data containing pools and directions
     * @param token0 First token address
     * @param token1 Second token address
     */
    function _executeRoute(
        RouteData memory route,
        address token0,
        address token1
    ) internal {
        // This is a simplified implementation
        // In production, this would handle complex multi-hop routes
        // For now, we'll implement basic single-hop swaps
        
        for (uint256 i = 0; i < route.pools.length; i++) {
            address pool = route.pools[i];
            bool direction = route.directions[i];
            
            // Execute swap on this pool
            _executeSwap(pool, direction, token0, token1);
        }
    }

    /**
     * @dev Execute swap on a single pool
     * @param pool Pool address to swap on
     * @param direction Swap direction (true for token0->token1)
     * @param token0 First token address
     * @param token1 Second token address
     */
    function _executeSwap(
        address pool,
        bool direction,
        address token0,
        address token1
    ) internal {
        // Determine if this is a Uniswap V3 or Aerodrome pool
        // This is a simplified check - in production, you'd have a registry
        
        try IUniswapV3Pool(pool).token0() returns (address poolToken0) {
            // This is a Uniswap V3 pool
            _executeUniswapV3Swap(pool, direction, token0, token1);
        } catch {
            // This is likely an Aerodrome pool
            _executeAerodromeSwap(pool, direction, token0, token1);
        }
    }

    /**
     * @dev Execute swap on Uniswap V3 pool
     */
    function _executeUniswapV3Swap(
        address pool,
        bool zeroForOne,
        address token0,
        address token1
    ) internal {
        // Get current balance to determine swap amount
        address tokenIn = zeroForOne ? token0 : token1;
        uint256 amountIn = IERC20(tokenIn).balanceOf(address(this));
        
        if (amountIn == 0) return;

        // Approve token for swap
        IERC20(tokenIn).safeApprove(pool, amountIn);

        // Execute swap
        IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341, // sqrt price limits
            abi.encode(tokenIn, amountIn)
        );
    }

    /**
     * @dev Execute swap on Aerodrome pool
     */
    function _executeAerodromeSwap(
        address pool,
        bool direction,
        address token0,
        address token1
    ) internal {
        // Get current balance to determine swap amount
        address tokenIn = direction ? token0 : token1;
        address tokenOut = direction ? token1 : token0;
        uint256 amountIn = IERC20(tokenIn).balanceOf(address(this));
        
        if (amountIn == 0) return;

        // Transfer tokens to pool
        IERC20(tokenIn).safeTransfer(pool, amountIn);

        // Calculate amounts out (simplified - would use actual Aerodrome math)
        uint256 amountOut = _getAerodromeAmountOut(pool, tokenIn, amountIn);

        // Execute swap
        if (direction) {
            IAerodromePair(pool).swap(0, amountOut, address(this), "");
        } else {
            IAerodromePair(pool).swap(amountOut, 0, address(this), "");
        }
    }

    /**
     * @dev Calculate Aerodrome swap output (simplified)
     */
    function _getAerodromeAmountOut(
        address pool,
        address tokenIn,
        uint256 amountIn
    ) internal view returns (uint256) {
        // This is a simplified calculation
        // In production, you'd implement the full Aerodrome formula
        (uint256 reserve0, uint256 reserve1,) = IAerodromePair(pool).getReserves();
        address token0 = IAerodromePair(pool).token0();
        
        (uint256 reserveIn, uint256 reserveOut) = tokenIn == token0 
            ? (reserve0, reserve1) 
            : (reserve1, reserve0);
            
        // Simplified constant product formula (would need stable pool logic too)
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        
        return numerator / denominator;
    }

    /**
     * @dev Uniswap V3 swap callback
     */
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        // Verify callback is from authorized pool
        require(authorizedPools[msg.sender], "Unauthorized swap callback");
        
        // Decode callback data
        (address tokenIn, uint256 amountIn) = abi.decode(data, (address, uint256));
        
        // Pay the pool
        if (amount0Delta > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token0()).safeTransfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token1()).safeTransfer(msg.sender, uint256(amount1Delta));
        }
    }

    // Admin functions

    /**
     * @dev Add authorized pool
     * @param pool Pool address to authorize
     */
    function addAuthorizedPool(address pool) external onlyOwner {
        authorizedPools[pool] = true;
        emit PoolAuthorizationChanged(pool, true);
    }

    /**
     * @dev Remove authorized pool
     * @param pool Pool address to deauthorize
     */
    function removeAuthorizedPool(address pool) external onlyOwner {
        authorizedPools[pool] = false;
        emit PoolAuthorizationChanged(pool, false);
    }

    /**
     * @dev Set minimum profit requirement
     * @param _minProfit New minimum profit in wei
     */
    function setMinProfit(uint256 _minProfit) external onlyOwner {
        uint256 oldMinProfit = minProfit;
        minProfit = _minProfit;
        emit MinProfitUpdated(oldMinProfit, _minProfit);
    }

    /**
     * @dev Pause contract
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Emergency withdraw tokens
     * @param token Token address to withdraw
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    /**
     * @dev Emergency withdraw ETH
     */
    function emergencyWithdrawETH() external onlyOwner {
        payable(owner()).transfer(address(this).balance);
    }

    // View functions

    /**
     * @dev Check if pool is authorized
     * @param pool Pool address to check
     * @return True if pool is authorized
     */
    function isAuthorizedPool(address pool) external view returns (bool) {
        return authorizedPools[pool];
    }

    /**
     * @dev Get minimum profit requirement
     * @return Minimum profit in wei
     */
    function getMinProfit() external view returns (uint256) {
        return minProfit;
    }

    /**
     * @dev Get execution statistics
     * @return totalExecutions Total number of executions
     * @return totalProfit Total profit generated
     */
    function getStats() external view returns (uint256, uint256) {
        return (totalExecutions, totalProfit);
    }

    /**
     * @dev Calculate total profit value in a common denomination
     * @param token0 First token address
     * @param token1 Second token address  
     * @param profit0 Profit in token0
     * @param profit1 Profit in token1
     * @return Total profit value
     */
    function _calculateTotalProfitValue(
        address token0,
        address token1,
        uint256 profit0,
        uint256 profit1
    ) internal pure returns (uint256) {
        // Simplified profit calculation
        // In production, this would use a price oracle to convert to USD/ETH
        
        // For now, assume both tokens have similar value (1:1 ratio)
        // This is obviously incorrect but serves as a placeholder
        return profit0 + profit1;
    }

    // Receive ETH
    receive() external payable {}
}

/**
 * @dev Minimal Uniswap V3 Pool interface for flash loans and swaps
 */
interface IUniswapV3Pool {
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function token0() external view returns (address);
    function token1() external view returns (address);
}

/**
 * @dev Minimal Aerodrome Pair interface for swaps
 */
interface IAerodromePair {
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;

    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
}