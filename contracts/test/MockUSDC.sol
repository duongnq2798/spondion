// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice 6-decimal test token mimicking USDC for local Foundry tests.
///         Uses standard ERC-20; does NOT simulate fee-on-transfer by default.
///         A separate FeeOnTransferToken contract below tests that path.
/// @dev LOCAL TEST FIXTURE — never deploy to any real network.
contract MockUSDC is ERC20 {
    uint8 private immutable _dec;

    constructor(uint8 decimals_) ERC20("Mock USDC", "mUSDC") {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    /// @notice Mint tokens to any address (test helper).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Burn tokens from any address (test helper).
    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @title FeeOnTransferToken
/// @notice ERC-20 that silently takes a 1-unit fee on every transferFrom.
///         Used to verify the exact-balance-delta deposit guard.
/// @dev LOCAL TEST FIXTURE — never deploy to any real network.
contract FeeOnTransferToken is ERC20 {
    uint8 private immutable _dec;
    address public feeCollector;

    constructor(uint8 decimals_, address _feeCollector) ERC20("FeeToken", "FEE") {
        _dec = decimals_;
        feeCollector = _feeCollector;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Intercept transferFrom and silently divert 1 unit to feeCollector.
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        // Deduct 1 unit fee silently
        require(amount > 0, "FeeToken: zero amount");
        address spender = _msgSender();
        _spendAllowance(from, spender, amount);
        if (amount > 1) {
            _transfer(from, feeCollector, 1);
            _transfer(from, to, amount - 1);
        } else {
            // amount == 1: the full amount goes to fee, nothing to recipient
            _transfer(from, feeCollector, 1);
        }
        return true;
    }
}

/// @title ReturnFalseToken
/// @notice ERC-20 that returns false from transferFrom without reverting.
///         SafeERC20.safeTransferFrom should catch the false return.
/// @dev LOCAL TEST FIXTURE — never deploy to any real network.
contract ReturnFalseToken is ERC20 {
    uint8 private immutable _dec;

    constructor(uint8 decimals_) ERC20("FalseToken", "FALSE") {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Returns false instead of reverting — SafeERC20 must reject this.
    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}
