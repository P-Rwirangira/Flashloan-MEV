// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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
        
        // Initiate flash loan
        IUniswapV3Pool(flashPool).flash(
            address(this),
            amount0,
            amount1,
            routeData
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

        // Decode route data
        RouteData memory route = abi.decode(data, (RouteData));
        
        // Execute arbitrage swaps
        _executeArbitrageSwaps(route);
        
        // Calculate repayment amounts
        uint256 amount0Owed = fee0;
        uint256 amount1Owed = fee1;
        
        // Repay flash loan
        if (amount0Owed > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token0()).safeTransfer(
                msg.sender,
                amount0Owed
            );
        }
        
        if (amount1Owed > 0) {
            IERC20(IUniswapV3Pool(msg.sender).token1()).safeTransfer(
                msg.sender,
                amount1Owed
            );
        }
    }

    /**
     * @dev Execute arbitrage swaps through multiple routes
     * @param route Route data containing pools and directions
     */
    function _executeArbitrageSwaps(RouteData memory route) internal {
        // Implementation will be added in next task
        // This is the foundation structure
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

/**
 * @dev Uniswap V3 Pool interface (minimal)
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