// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/**
 * @title FlashExecutor
 * @dev Executes flash loan arbitrage on Base blockchain
 */
contract FlashExecutor is IUniswapV3FlashCallback, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct RouteData {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address[] pools;
        uint24[] fees;
        bool[] directions;
        uint256 deadline;
    }

    struct FlashParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minProfit;
        RouteData route;
    }

    mapping(address => bool) public authorizedPools;
    mapping(address => bool) public authorizedCallers;
    uint256 public minProfit;
    
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

    modifier onlyAuthorizedCaller() {
        require(authorizedCallers[msg.sender] || msg.sender == owner(), "Unauthorized caller");
        _;
    }

    modifier onlyAuthorizedPool() {
        require(authorizedPools[msg.sender], "Unauthorized pool");
        _;
    }

    constructor(uint256 _minProfit) Ownable(msg.sender) {
        minProfit = _minProfit;
        authorizedCallers[msg.sender] = true;
    }

    /**
     * @dev Execute arbitrage using flash loan
     */
    function executeArbitrage(
        address flashPool,
        uint256 amount0,
        uint256 amount1,
        bytes calldata routeData
    ) external nonReentrant whenNotPaused onlyAuthorizedCaller {
        require(authorizedPools[flashPool], "Pool not authorized");
        require(amount0 > 0 || amount1 > 0, "Invalid amounts");
        
        uint256 gasStart = gasleft();
        
        try IUniswapV3Pool(flashPool).flash(
            address(this),
            amount0,
            amount1,
            routeData
        ) {
            // Success handled in callback
        } catch Error(string memory reason) {
            emit ArbitrageFailed(msg.sender, reason, gasStart - gasleft());
            revert(reason);
        }
    }

    /**
     * @dev Uniswap V3 flash callback
     */
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override onlyAuthorizedPool {
        FlashParams memory params = abi.decode(data, (FlashParams));
        
        uint256 gasStart = gasleft();
        uint256 amountOwed = params.amountIn + (fee0 > 0 ? fee0 : fee1);
        
        // Record initial balance
        uint256 initialBalance = IERC20(params.tokenIn).balanceOf(address(this));
        
        // Execute arbitrage route
        uint256 amountOut = _executeRoute(params.route);
        
        // Calculate profit
        uint256 finalBalance = IERC20(params.tokenIn).balanceOf(address(this));
        require(finalBalance >= amountOwed, "Insufficient funds to repay");
        
        uint256 profit = finalBalance - initialBalance;
        require(profit >= params.minProfit, "Insufficient profit");
        
        // Repay flash loan
        IERC20(params.tokenIn).safeTransfer(msg.sender, amountOwed);
        
        // Transfer profit to caller
        if (profit > 0) {
            IERC20(params.tokenIn).safeTransfer(tx.origin, profit);
        }
        
        emit ArbitrageExecuted(
            tx.origin,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            profit,
            gasStart - gasleft()
        );
    }

    /**
     * @dev Execute arbitrage route through multiple pools
     */
    function _executeRoute(RouteData memory route) internal returns (uint256 amountOut) {
        require(route.deadline >= block.timestamp, "Transaction expired");
        require(route.pools.length > 0, "Empty route");
        
        uint256 currentAmount = route.amountIn;
        address currentToken = route.tokenIn;
        
        for (uint256 i = 0; i < route.pools.length; i++) {
            address pool = route.pools[i];
            require(authorizedPools[pool], "Unauthorized pool in route");
            
            // Execute swap on pool
            currentAmount = _swapOnPool(
                pool,
                currentToken,
                currentAmount,
                route.directions[i]
            );
            
            // Update current token for next iteration
            currentToken = _getOtherToken(pool, currentToken);
        }
        
        require(currentAmount >= route.minAmountOut, "Insufficient output amount");
        return currentAmount;
    }

    /**
     * @dev Execute swap on a single pool
     */
    function _swapOnPool(
        address pool,
        address tokenIn,
        uint256 amountIn,
        bool zeroForOne
    ) internal returns (uint256 amountOut) {
        // Transfer tokens to pool
        IERC20(tokenIn).safeTransfer(pool, amountIn);
        
        // Execute swap
        (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341, // sqrt price limits
            ""
        );
        
        return uint256(-(zeroForOne ? amount1 : amount0));
    }

    /**
     * @dev Get the other token in a pool
     */
    function _getOtherToken(address pool, address token) internal view returns (address) {
        address token0 = IUniswapV3Pool(pool).token0();
        address token1 = IUniswapV3Pool(pool).token1();
        
        if (token == token0) {
            return token1;
        } else if (token == token1) {
            return token0;
        } else {
            revert("Token not in pool");
        }
    }

    /**
     * @dev Add authorized pool
     */
    function addAuthorizedPool(address pool) external onlyOwner {
        authorizedPools[pool] = true;
        emit PoolAuthorizationChanged(pool, true);
    }

    /**
     * @dev Remove authorized pool
     */
    function removeAuthorizedPool(address pool) external onlyOwner {
        authorizedPools[pool] = false;
        emit PoolAuthorizationChanged(pool, false);
    }

    /**
     * @dev Add authorized caller
     */
    function addAuthorizedCaller(address caller) external onlyOwner {
        authorizedCallers[caller] = true;
    }

    /**
     * @dev Remove authorized caller
     */
    function removeAuthorizedCaller(address caller) external onlyOwner {
        authorizedCallers[caller] = false;
    }

    /**
     * @dev Set minimum profit threshold
     */
    function setMinProfit(uint256 _minProfit) external onlyOwner {
        minProfit = _minProfit;
    }

    /**
     * @dev Emergency withdraw tokens
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    /**
     * @dev Emergency withdraw all tokens
     */
    function emergencyWithdrawAll(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).safeTransfer(owner(), balance);
        }
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
     * @dev Check if pool is authorized
     */
    function isAuthorizedPool(address pool) external view returns (bool) {
        return authorizedPools[pool];
    }

    /**
     * @dev Get minimum profit
     */
    function getMinProfit() external view returns (uint256) {
        return minProfit;
    }
}