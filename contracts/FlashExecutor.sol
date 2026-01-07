// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

// Protocol interfaces - defined outside contract
interface IAaveV3Pool {
    function liquidationCall(
        address collateral,
        address debt,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

interface ICompoundCToken {
    function liquidateBorrow(address borrower, uint256 repayAmount, address cTokenCollateral) external returns (uint256);
    function redeem(uint256 redeemTokens) external returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function underlying() external view returns (address);
}

/**
 * @title FlashExecutor
 * @dev Executes flash loan arbitrage on Base blockchain
 */
contract FlashExecutor is IUniswapV3FlashCallback, IUniswapV3SwapCallback, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    enum OperationMode { ARBITRAGE, LIQUIDATION }

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
        // amounts requested in IUniswapV3Pool.flash
        uint256 amount0;
        uint256 amount1;
        // economic params
        uint256 minProfit;
        address recipient;
        OperationMode mode;
        bytes liquidationData; // encoded LiquidationPayload when mode=LIQUIDATION
        // route for post-liquidation swaps if needed
        RouteData route;
    }

    enum ProtocolType { AAVE_V3, COMPOUND_LIKE }

    struct LiquidationPayload {
        ProtocolType protocol;
        address borrower;
        address debtAsset;        // underlying debt asset (AAVE and Compound)
        address collateralAsset;  // underlying collateral asset (AAVE), for Compound this is underlying of cTokenCollateral
        uint256 debtToCover;      // amount of debt to repay (in underlying units)
        // Protocol specific fields
        address protocolAddress;  // Aave: Pool address
        address cDebtToken;       // Compound: cToken of debt market
        address cCollateralToken; // Compound: cToken of collateral market
        bool receiveAToken;       // Aave: whether to receive aTokens (we expect false to receive underlying)
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
    event LiquidationExecuted(
        address indexed caller,
        address indexed debtAsset,
        address indexed collateralAsset,
        address borrower,
        uint256 debtCovered,
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
    
    event CallerAuthorizationChanged(
        address indexed caller,
        bool authorized
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
        
        // Decode route to validate basic structure and bind tokens/amounts
        RouteData memory route = abi.decode(routeData, (RouteData));
        require(route.pools.length > 0, "Invalid route");
        
        uint256 gasStart = gasleft();
        
        // Build callback payload
        FlashParams memory params = FlashParams({
            amount0: amount0,
            amount1: amount1,
            minProfit: minProfit,
            recipient: msg.sender,
            mode: OperationMode.ARBITRAGE,
            liquidationData: bytes("") ,
            route: route
        });
        bytes memory data = abi.encode(params);
        
        try IUniswapV3Pool(flashPool).flash(
            address(this),
            amount0,
            amount1,
            data
        ) {
            // Success handled in callback
        } catch Error(string memory reason) {
            emit ArbitrageFailed(msg.sender, reason, gasStart - gasleft());
            revert(reason);
        }
    }

    /**
     * @dev Execute liquidation using flash loan. liquidationData encodes LiquidationPayload. routeData may be used
     *      to swap borrowedToken->debtAsset pre-liquidation and collateral->borrowedToken post-liquidation.
     */
    function executeLiquidationFlash(
        address flashPool,
        uint256 amount0,
        uint256 amount1,
        bytes calldata liquidationData,
        bytes calldata routeData
    ) external nonReentrant whenNotPaused onlyAuthorizedCaller {
        require(authorizedPools[flashPool], "Pool not authorized");
        require(amount0 > 0 || amount1 > 0, "Invalid amounts");
        require(liquidationData.length > 0, "Missing liquidation data");

        RouteData memory route = abi.decode(routeData, (RouteData));
        // route may be empty; we will handle accordingly

        FlashParams memory params = FlashParams({
            amount0: amount0,
            amount1: amount1,
            minProfit: minProfit,
            recipient: msg.sender,
            mode: OperationMode.LIQUIDATION,
            liquidationData: liquidationData,
            route: route
        });

        bytes memory data = abi.encode(params);
        IUniswapV3Pool(flashPool).flash(address(this), amount0, amount1, data);
    }

    /**
     * @dev Uniswap V3 flash callback
     */
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override onlyAuthorizedPool { require(!paused(), "Paused");
        FlashParams memory params = abi.decode(data, (FlashParams));
        
        uint256 gasStart = gasleft();
        
        // Determine borrowed token and amount owed
        address pool = params.route.pools[0];
        address token0 = IUniswapV3Pool(pool).token0();
        address token1 = IUniswapV3Pool(pool).token1();
        
        uint256 amountOwed;
        uint256 borrowedAmount;
        uint256 fee;
        address borrowedToken;
        // Determine borrowed token by non-zero requested amount (fallback to fee indicator for safety)
        if (params.amount0 > 0 || fee0 > 0) {
            borrowedToken = token0;
            borrowedAmount = params.amount0;
            fee = fee0;
        } else {
            borrowedToken = token1;
            borrowedAmount = params.amount1;
            fee = fee1;
        }
        amountOwed = borrowedAmount + fee;
        
        // Record initial balance for borrowed token
        uint256 initialBalance = IERC20(borrowedToken).balanceOf(address(this));
        
        uint256 finalBalance;
        uint256 profit;
        
        if (params.mode == OperationMode.ARBITRAGE) {
            // Execute arbitrage route
            _executeRoute(params.route);
            // Calculate profit from actual balance change and ensure repayable
            finalBalance = IERC20(borrowedToken).balanceOf(address(this));
            require(finalBalance >= initialBalance + fee, "Insufficient funds to repay");
            profit = finalBalance - initialBalance - fee;
        } else {
            // Execute liquidation path
            profit = _executeLiquidationAndComputeProfit(borrowedToken, amountOwed, params);
            finalBalance = IERC20(borrowedToken).balanceOf(address(this));
        }
        
        require(profit >= params.minProfit, "Insufficient profit");
        
        // Repay flash loan
        IERC20(borrowedToken).safeTransfer(msg.sender, amountOwed);
        
        // Transfer profit to recipient
        require(params.recipient != address(0), "Invalid recipient");
        if (profit > 0) {
            IERC20(borrowedToken).safeTransfer(params.recipient, profit);
        }
        
        if (params.mode == OperationMode.ARBITRAGE) {
            emit ArbitrageExecuted(
                params.recipient,
                params.route.tokenIn,
                params.route.tokenOut,
                params.route.amountIn,
                profit,
                gasStart - gasleft()
            );
        } else {
            LiquidationPayload memory lq2 = abi.decode(params.liquidationData, (LiquidationPayload));
            emit LiquidationExecuted(
                params.recipient,
                lq2.debtAsset,
                lq2.collateralAsset,
                lq2.borrower,
                lq2.debtToCover,
                profit,
                gasStart - gasleft()
            );
        }
    }

    /**
     * @dev Uniswap V3 swap callback
     */
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override onlyAuthorizedPool {
        require(!paused(), "Paused");
        require(amount0Delta > 0 || amount1Delta > 0, "Invalid swap");
        
        // Compute the actual owed amount from deltas (positive delta is what we owe)
        uint256 actualAmountOwed;
        if (amount0Delta > 0) {
            actualAmountOwed = uint256(amount0Delta);
        } else {
            actualAmountOwed = uint256(amount1Delta);
        }
        
        // Decode callback data to get payer and token info
        (address tokenIn, address payer, uint256 decodedAmountOwed) = abi.decode(data, (address, address, uint256));
        
        // Validate that decoded amount matches computed amount for security
        require(decodedAmountOwed == actualAmountOwed, "Amount mismatch: decoded vs computed");
        
        // Transfer owed tokens to pool - handle self-payment case
        if (payer == address(this)) {
            // Contract is paying from its own balance using delta-derived amount
            IERC20(tokenIn).safeTransfer(msg.sender, actualAmountOwed);
        } else {
            // External payer needs approval using delta-derived amount
            IERC20(tokenIn).safeTransferFrom(payer, msg.sender, actualAmountOwed);
        }
    }

    /**
     * @dev Execute arbitrage route through multiple pools
     */
    function _executeRoute(RouteData memory route) internal returns (uint256 amountOut) {
        require(route.deadline == 0 || route.deadline >= block.timestamp, "Transaction expired");
        if (route.pools.length == 0) {
            return route.amountIn; // no-op route
        }
        
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
        
        require(route.minAmountOut == 0 || currentAmount >= route.minAmountOut, "Insufficient output amount");
        return currentAmount;
    }

    /**
     * @dev Execute swap on a single pool using callback pattern
     */
    function _swapOnPool(
        address pool,
        address tokenIn,
        uint256 amountIn,
        bool zeroForOne
    ) internal returns (uint256 amountOut) {
        // Encode callback data for the swap
        bytes memory callbackData = abi.encode(tokenIn, address(this), amountIn);
        
        // Execute swap - tokens will be transferred in callback
        (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341, // sqrt price limits
            callbackData
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

    // Execute liquidation and compute profit in borrowed token units
    function _executeLiquidationAndComputeProfit(
        address borrowedToken,
        uint256 amountOwed,
        FlashParams memory params
    ) internal returns (uint256) {
        LiquidationPayload memory lq = abi.decode(params.liquidationData, (LiquidationPayload));
        require(lq.debtAsset != address(0) && lq.borrower != address(0), "Invalid liquidation payload");

        // If borrowed token != debt asset, swap via route (pre-liquidation)
        if (borrowedToken != lq.debtAsset && params.route.pools.length > 0) {
            // adjust route to swap borrowedToken->debtAsset
            RouteData memory preRoute = params.route;
            preRoute.tokenIn = borrowedToken;
            preRoute.tokenOut = lq.debtAsset;
            preRoute.amountIn = IERC20(borrowedToken).balanceOf(address(this));
            _executeRoute(preRoute);
        }

        uint256 balBefore = IERC20(borrowedToken).balanceOf(address(this));
        uint256 debtBefore = IERC20(lq.debtAsset).balanceOf(address(this));
        uint256 collBefore = IERC20(lq.collateralAsset).balanceOf(address(this));

        if (lq.protocol == ProtocolType.AAVE_V3) {
            // Approve debt to pool
            IERC20(lq.debtAsset).approve(lq.protocolAddress, lq.debtToCover);
            IAaveV3Pool(lq.protocolAddress).liquidationCall(
                lq.collateralAsset,
                lq.debtAsset,
                lq.borrower,
                lq.debtToCover,
                lq.receiveAToken
            );
        } else if (lq.protocol == ProtocolType.COMPOUND_LIKE) {
            // Approve debt asset to cToken of debt if needed (for some implementations repay via debt underlying)
            IERC20(lq.debtAsset).approve(lq.cDebtToken, lq.debtToCover);
            uint256 res = ICompoundCToken(lq.cDebtToken).liquidateBorrow(lq.borrower, lq.debtToCover, lq.cCollateralToken);
            require(res == 0, "Compound liquidation failed");
            // Redeem seized cTokens to underlying collateral
            uint256 cBal = ICompoundCToken(lq.cCollateralToken).balanceOf(address(this));
            if (cBal > 0) {
                ICompoundCToken(lq.cCollateralToken).redeem(cBal);
            }
        } else {
            revert("Unsupported protocol");
        }

        uint256 debtAfter = IERC20(lq.debtAsset).balanceOf(address(this));
        uint256 collAfter = IERC20(lq.collateralAsset).balanceOf(address(this));

        // Post-liquidation: swap collateral to borrowed token to repay and realize profit
        if (collAfter > collBefore && params.route.pools.length > 0) {
            RouteData memory postRoute = params.route;
            postRoute.tokenIn = lq.collateralAsset;
            postRoute.tokenOut = borrowedToken;
            postRoute.amountIn = collAfter - collBefore;
            _executeRoute(postRoute);
        }

        uint256 balAfter = IERC20(borrowedToken).balanceOf(address(this));
        require(balAfter >= amountOwed, "Insufficient post-liquidation balance");
        return balAfter - amountOwed;
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
        emit CallerAuthorizationChanged(caller, true);
    }

    /**
     * @dev Remove authorized caller
     */
    function removeAuthorizedCaller(address caller) external onlyOwner {
        authorizedCallers[caller] = false;
        emit CallerAuthorizationChanged(caller, false);
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