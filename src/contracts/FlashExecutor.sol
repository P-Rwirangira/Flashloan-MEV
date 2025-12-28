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

        // Calculate profit
        uint256 profit0 = finalBalance0 - repayAmount0;
        uint256 profit1 = finalBalance1 - repayAmount1;
        uint256 totalProfitValue = profit0 + profit1; // Simplified - would need price conversion

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
        // This is a placeholder for actual swap execution
        // In production, this would call the appropriate DEX functions
        // (Uniswap V3 or Aerodrome) based on pool type
        
        // For now, we'll just emit an event to indicate swap attempt
        // The actual implementation would be added in task 9.5
        
        // Placeholder to prevent unused parameter warnings
        pool;
        direction;
        token0;
        token1;
        
        // Actual swap logic will be implemented in task 9.5
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

    // Receive ETH
    receive() external payable {}
}

/**
 * @dev Minimal Uniswap V3 Pool interface for flash loans
 */
interface IUniswapV3Pool {
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;

    function token0() external view returns (address);
    function token1() external view returns (address);
}