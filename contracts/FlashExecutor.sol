// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/**
 * @title FlashExecutor
 * @dev Gas-optimized flash loan arbitrage executor for Base L2
 * @notice Executes atomic arbitrage trades using Uniswap V3 flash loans
 */
contract FlashExecutor is IUniswapV3FlashCallback, ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    // Constants for gas optimization
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    // State variables
    uint256 public minProfit;
    mapping(address => bool) public authorizedPools;
    
    // Statistics
    uint256 public totalExecutions;
    uint256 public totalProfit;
    uint256 public totalGasUsed;

    // Swap route structure
    struct SwapRoute {
        address[] pools;
        address[] tokens; // Token path for multi-hop routes
        bool[] directions;
        uint256 minProfit;
        uint256 deadline;
    }

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

    event UnauthorizedCallbackAttempt(
        address indexed caller,
        address indexed pool
    );

    event InsufficientProfitEvent(
        uint256 actualProfit,
        uint256 minProfit
    );

    event PoolAuthorizationChanged(
        address indexed pool,
        bool isAuthorized
    );

    // Custom errors for gas efficiency
    error UnauthorizedCallback();
    error InsufficientProfit(uint256 actual, uint256 required);
    error SwapFailed(address pool, bytes reason);
    error FlashLoanRepaymentFailed(uint256 owed, uint256 available);
    error InvalidRoute();
    error DeadlineExceeded();
    error InvalidAmount();

    constructor(uint256 _minProfit) Ownable(msg.sender) {
        minProfit = _minProfit;
    }

    /**
     * @dev Execute arbitrage using Uniswap V3 flash loan
     * @param flashPool The pool to borrow from
     * @param amount0 Amount of token0 to borrow
     * @param amount1 Amount of token1 to borrow
     * @param routeData Encoded swap route data
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

        if (amount0 == 0 && amount1 == 0) {
            revert InvalidAmount();
        }

        uint256 gasStart = gasleft();

        try IUniswapV3Pool(flashPool).flash(
            address(this),
            amount0,
            amount1,
            routeData
        ) {
            // Success - update statistics
            unchecked {
                totalExecutions++;
                totalGasUsed += gasStart - gasleft();
            }
        } catch (bytes memory reason) {
            emit ArbitrageFailed(msg.sender, string(reason), gasStart - gasleft());
            revert SwapFailed(flashPool, reason);
        }
    }

    /**
     * @dev Uniswap V3 flash callback - executes the arbitrage logic
     * @param fee0 Fee for token0
     * @param fee1 Fee for token1
     * @param data Encoded route data
     */
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        // Validate caller is authorized pool
        if (!authorizedPools[msg.sender]) {
            emit UnauthorizedCallbackAttempt(tx.origin, msg.sender);
            revert UnauthorizedCallback();
        }

        // Decode route data
        SwapRoute memory route = abi.decode(data, (SwapRoute));

        // Check deadline
        if (block.timestamp > route.deadline) {
            revert DeadlineExceeded();
        }

        // Validate route
        if (route.pools.length == 0 || route.pools.length != route.directions.length || route.tokens.length == 0) {
            revert InvalidRoute();
        }

        // Determine borrowed token from amounts and pool tokens
        address token0 = IUniswapV3Pool(msg.sender).token0();
        address token1 = IUniswapV3Pool(msg.sender).token1();
        address borrowedToken;
        uint256 borrowedAmount;
        
        // Get borrowed amounts from flash loan parameters
        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        
        if (amount0 > 0 && amount1 == 0) {
            borrowedToken = token0;
            borrowedAmount = amount0;
        } else if (amount1 > 0 && amount0 == 0) {
            borrowedToken = token1;
            borrowedAmount = amount1;
        } else if (amount0 > 0 && amount1 > 0) {
            // Both tokens borrowed - use the first token in route
            borrowedToken = route.tokens[0];
            borrowedAmount = borrowedToken == token0 ? amount0 : amount1;
        } else {
            revert InvalidAmount();
        }

        uint256 initialBalance = borrowedAmount;

        // Execute swaps
        _executeSwaps(route);

        // Calculate profit
        uint256 finalBalance = IERC20(borrowedToken).balanceOf(address(this));
        uint256 totalFee = fee0 + fee1;
        
        if (finalBalance < initialBalance + totalFee) {
            revert FlashLoanRepaymentFailed(initialBalance + totalFee, finalBalance);
        }

        uint256 profit = finalBalance - initialBalance - totalFee;
        
        if (profit < route.minProfit) {
            emit InsufficientProfitEvent(profit, route.minProfit);
            revert InsufficientProfit(profit, route.minProfit);
        }

        if (profit < minProfit) {
            emit InsufficientProfitEvent(profit, minProfit);
            revert InsufficientProfit(profit, minProfit);
        }

        // Repay flash loan
        IERC20(borrowedToken).safeTransfer(msg.sender, initialBalance + totalFee);

        // Update profit statistics
        unchecked {
            totalProfit += profit;
        }

        // Emit success event
        emit ArbitrageExecuted(
            tx.origin,
            borrowedToken,
            borrowedToken, // Same token for arbitrage
            initialBalance,
            profit,
            0 // Gas will be calculated in main function
        );
    }

    /**
     * @dev Execute swap sequence with proper token tracking and approvals
     * @param route The swap route to execute
     */
    function _executeSwaps(SwapRoute memory route) internal {
        address currentToken = route.tokens[0];
        
        for (uint256 i = 0; i < route.pools.length;) {
            address pool = route.pools[i];
            bool direction = route.directions[i];
            
            uint256 amountIn = IERC20(currentToken).balanceOf(address(this));
            
            if (amountIn == 0) {
                revert InvalidAmount();
            }

            // Approve the pool to spend the input token
            IERC20(currentToken).safeApprove(pool, amountIn);

            try IUniswapV3Pool(pool).swap(
                address(this),
                direction,
                int256(amountIn),
                direction ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                ""
            ) {
                // Reset approval after successful swap
                IERC20(currentToken).safeApprove(pool, 0);
                
                // Update current token for next iteration
                if (i + 1 < route.tokens.length) {
                    currentToken = route.tokens[i + 1];
                }
            } catch (bytes memory reason) {
                // Reset approval on failure
                IERC20(currentToken).safeApprove(pool, 0);
                revert SwapFailed(pool, reason);
            }

            unchecked {
                i++;
            }
        }
    }

    /**
     * @dev Get token address from pool based on which token has fee
     * @param pool The pool address
     * @param isToken0 Whether token0 has the fee
     * @return token The token address
     */
    function _getTokenFromPool(address pool, bool isToken0) internal view returns (address token) {
        if (isToken0) {
            token = IUniswapV3Pool(pool).token0();
        } else {
            token = IUniswapV3Pool(pool).token1();
        }
    }

    /**
     * @dev Add authorized pool (owner only)
     * @param pool Pool address to authorize
     */
    function addAuthorizedPool(address pool) external onlyOwner {
        authorizedPools[pool] = true;
        emit PoolAuthorizationChanged(pool, true);
    }

    /**
     * @dev Remove authorized pool (owner only)
     * @param pool Pool address to deauthorize
     */
    function removeAuthorizedPool(address pool) external onlyOwner {
        authorizedPools[pool] = false;
        emit PoolAuthorizationChanged(pool, false);
    }

    /**
     * @dev Set minimum profit requirement (owner only)
     * @param _minProfit New minimum profit in wei
     */
    function setMinProfit(uint256 _minProfit) external onlyOwner {
        minProfit = _minProfit;
    }

    /**
     * @dev Check if pool is authorized
     * @param pool Pool address to check
     * @return Whether pool is authorized
     */
    function isAuthorizedPool(address pool) external view returns (bool) {
        return authorizedPools[pool];
    }

    /**
     * @dev Get minimum profit requirement
     * @return Current minimum profit in wei
     */
    function getMinProfit() external view returns (uint256) {
        return minProfit;
    }

    /**
     * @dev Pause contract (owner only)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause contract (owner only)
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Emergency withdraw specific amount (owner only)
     * @param token Token to withdraw
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    /**
     * @dev Emergency withdraw all tokens (owner only)
     * @param token Token to withdraw
     */
    function emergencyWithdrawAll(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(owner(), balance);
        }
    }

    /**
     * @dev Get contract statistics
     * @return executions Total number of executions
     * @return profit Total profit generated
     * @return gasUsed Total gas used
     */
    function getStats() external view returns (
        uint256 executions,
        uint256 profit,
        uint256 gasUsed
    ) {
        return (totalExecutions, totalProfit, totalGasUsed);
    }

    /**
     * @dev Receive function to accept ETH
     */
    receive() external payable {}
}