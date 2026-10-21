// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SpondionPrepaidEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /**
     * @dev Invariants and operating model:
     * - totalLiabilities == (sum of all channel balances) + (sum of all provider credits).
     * - usdc.balanceOf(address(this)) >= totalLiabilities should always hold.
     * - This contract has no privileged admin, no upgrade path, and no fee extraction mechanism.
     * - Grace duration allows pending vouchers to settle before refund; it does NOT prove a voucher
     *   was signed before closing.
     * - Multiple outstanding vouchers do NOT reserve collateral; first successful settlement wins.
     *   Close-race risk is the caller's responsibility.
     * - Amounts are always micro-USDC (6-decimal ERC-20 integer units), never native gas units.
     *
     * Production recommendation: set GRACE_DURATION to 24 hours. Shorter values are suitable for demos.
     *
     * Fix log (audit round 1):
     * [F1] Constructor now enforces 1 second <= grace <= 30 days to prevent uint256 overflow when
     *      computing block.timestamp + GRACE_DURATION, and blocks extreme values that would make
     *      channels permanently uncloseable.
     * [F2] refundAvailableAt is stored as uint256 to avoid silent truncation when assigning
     *      block.timestamp + GRACE_DURATION.  The ClosingRequested event now emits uint256.
     * [F3] openChannel rejects payout == address(this); credited provider earnings would be
     *      permanently unwithdrawable if payout points to the escrow contract itself.
     * [F4] Voucher deadline is now INCLUSIVE: block.timestamp <= deadline (was strictly less-than).
     * [F5] getChannel reverts for channelId >= nextChannelId so the view can never return a
     *      zero-initialised struct that falsely appears Active.
     */

    // ── Bounds ────────────────────────────────────────────────────────────────────
    uint256 public constant MIN_GRACE = 1;          // 1 second
    uint256 public constant MAX_GRACE = 30 days;    // 2_592_000 seconds

    // ── Types ─────────────────────────────────────────────────────────────────────

    enum ChannelState {
        Active,
        Closing,
        Closed
    }

    struct Channel {
        address owner;
        address provider;
        address payout;
        address signer;
        uint256 pricePerUnit;
        uint256 perCallCap;
        uint256 lifetimeCap;
        uint256 balance;
        uint256 spent;
        uint256 refundAvailableAt;  // [F2] widened from uint64 to uint256
        ChannelState state;
    }

    // ── Immutables ────────────────────────────────────────────────────────────────

    IERC20 public immutable usdc;
    uint256 public immutable GRACE_DURATION;
    bytes32 private immutable _VOUCHER_TYPEHASH;

    // ── State ─────────────────────────────────────────────────────────────────────

    mapping(uint256 => Channel) public channels;
    mapping(uint256 => mapping(bytes32 => bool)) public consumedVouchers;
    mapping(address => uint256) public providerCredit;

    uint256 public nextChannelId;
    uint256 public totalLiabilities;

    // ── Events ────────────────────────────────────────────────────────────────────

    event ChannelOpened(
        uint256 indexed channelId,
        address indexed owner,
        address indexed provider,
        address payout,
        address signer,
        uint256 pricePerUnit,
        uint256 perCallCap,
        uint256 lifetimeCap
    );
    event Deposited(uint256 indexed channelId, uint256 amount, uint256 newBalance);
    event UsageSettled(uint256 indexed channelId, bytes32 indexed requestId, uint256 units, uint256 amount);
    event ClosingRequested(uint256 indexed channelId, uint256 refundAvailableAt); // [F2] uint256
    event Refunded(uint256 indexed channelId, uint256 amount, address owner);
    event ProviderWithdrawn(address indexed payout, uint256 amount);

    // ── Constructor ───────────────────────────────────────────────────────────────

    constructor(address _usdc, uint256 _graceDuration) EIP712("SpondionPrepaidEscrow", "1") {
        require(_usdc != address(0), "USDC_ZERO");
        // [F1] Practical bounds: 1 second <= grace <= 30 days
        require(_graceDuration >= MIN_GRACE, "GRACE_TOO_SHORT");
        require(_graceDuration <= MAX_GRACE, "GRACE_TOO_LONG");

        usdc = IERC20(_usdc);
        GRACE_DURATION = _graceDuration;
        _VOUCHER_TYPEHASH = keccak256("UsageVoucher(uint256 channelId,bytes32 requestId,uint256 units,uint256 deadline)");
    }

    // ── openChannel ───────────────────────────────────────────────────────────────

    function openChannel(
        address provider,
        address payout,
        address signer,
        uint256 pricePerUnit,
        uint256 perCallCap,
        uint256 lifetimeCap
    ) external returns (uint256 channelId) {
        require(provider != address(0), "PROVIDER_ZERO");
        require(payout != address(0), "PAYOUT_ZERO");
        require(payout != address(this), "PAYOUT_IS_ESCROW"); // [F3]
        require(pricePerUnit > 0, "PRICE_ZERO");
        require(perCallCap > 0, "PER_CALL_CAP_ZERO");
        require(lifetimeCap > 0, "LIFETIME_CAP_ZERO");
        require(perCallCap <= lifetimeCap, "CAP_MISMATCH");

        address effectiveSigner = signer == address(0) ? msg.sender : signer;

        channelId = nextChannelId;
        nextChannelId = channelId + 1;

        Channel storage channel = channels[channelId];
        channel.owner = msg.sender;
        channel.provider = provider;
        channel.payout = payout;
        channel.signer = effectiveSigner;
        channel.pricePerUnit = pricePerUnit;
        channel.perCallCap = perCallCap;
        channel.lifetimeCap = lifetimeCap;
        channel.balance = 0;
        channel.spent = 0;
        channel.refundAvailableAt = 0;
        channel.state = ChannelState.Active;

        emit ChannelOpened(
            channelId,
            msg.sender,
            provider,
            payout,
            effectiveSigner,
            pricePerUnit,
            perCallCap,
            lifetimeCap
        );
    }

    // ── deposit ───────────────────────────────────────────────────────────────────

    function deposit(uint256 channelId, uint256 amount) external nonReentrant {
        Channel storage channel = channels[channelId];

        require(channel.state == ChannelState.Active, "NOT_ACTIVE");
        require(amount > 0, "AMOUNT_ZERO");
        require(msg.sender == channel.owner, "NOT_OWNER");

        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = usdc.balanceOf(address(this));

        uint256 received = balanceAfter - balanceBefore;
        require(received == amount, "BAD_TOKEN_DELTA");

        channel.balance += received;
        totalLiabilities += received;

        emit Deposited(channelId, received, channel.balance);
    }

    // ── settleUsage ───────────────────────────────────────────────────────────────

    function settleUsage(
        uint256 channelId,
        bytes32 requestId,
        uint256 units,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        Channel storage channel = channels[channelId];

        require(msg.sender == channel.provider, "NOT_PROVIDER");
        require(
            channel.state == ChannelState.Active || channel.state == ChannelState.Closing,
            "BAD_STATE"
        );
        require(requestId != bytes32(0), "REQUEST_ID_ZERO");
        require(units > 0, "UNITS_ZERO");
        require(block.timestamp <= deadline, "VOUCHER_EXPIRED"); // [F4] inclusive deadline

        if (channel.state == ChannelState.Closing) {
            require(block.timestamp < channel.refundAvailableAt, "REFUND_WINDOW_REACHED");
        }

        require(!consumedVouchers[channelId][requestId], "VOUCHER_USED");

        uint256 amount = units * channel.pricePerUnit;

        require(amount <= channel.perCallCap, "PER_CALL_CAP_EXCEEDED");
        require(channel.spent + amount <= channel.lifetimeCap, "LIFETIME_CAP_EXCEEDED");
        require(channel.balance >= amount, "INSUFFICIENT_CHANNEL_BALANCE");

        bytes32 structHash = keccak256(
            abi.encode(_VOUCHER_TYPEHASH, channelId, requestId, units, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        require(
            SignatureChecker.isValidSignatureNow(channel.signer, digest, signature),
            "INVALID_SIGNATURE"
        );

        consumedVouchers[channelId][requestId] = true;
        channel.balance -= amount;
        channel.spent += amount;
        providerCredit[channel.payout] += amount;

        emit UsageSettled(channelId, requestId, units, amount);
    }

    // ── requestClose ──────────────────────────────────────────────────────────────

    function requestClose(uint256 channelId) external {
        Channel storage channel = channels[channelId];

        require(msg.sender == channel.owner, "NOT_OWNER");
        require(channel.state == ChannelState.Active, "NOT_ACTIVE");

        channel.state = ChannelState.Closing;
        // [F2] Safe: GRACE_DURATION <= 30 days, block.timestamp never near uint256 max
        channel.refundAvailableAt = block.timestamp + GRACE_DURATION;

        emit ClosingRequested(channelId, channel.refundAvailableAt);
    }

    // ── finalizeRefund ────────────────────────────────────────────────────────────

    function finalizeRefund(uint256 channelId) external nonReentrant {
        Channel storage channel = channels[channelId];

        require(msg.sender == channel.owner, "NOT_OWNER");
        require(channel.state == ChannelState.Closing, "NOT_CLOSING");
        require(block.timestamp >= channel.refundAvailableAt, "GRACE_NOT_ELAPSED");

        uint256 refundAmt = channel.balance;
        channel.balance = 0;
        channel.state = ChannelState.Closed;

        totalLiabilities -= refundAmt;

        if (refundAmt > 0) {
            usdc.safeTransfer(channel.owner, refundAmt);
        }

        emit Refunded(channelId, refundAmt, channel.owner);
    }

    // ── withdraw ──────────────────────────────────────────────────────────────────

    function withdraw() external nonReentrant {
        uint256 credit = providerCredit[msg.sender];
        require(credit > 0, "NO_CREDIT");

        providerCredit[msg.sender] = 0;
        totalLiabilities -= credit;
        usdc.safeTransfer(msg.sender, credit);

        emit ProviderWithdrawn(msg.sender, credit);
    }

    // ── Views ─────────────────────────────────────────────────────────────────────

    /// @notice Returns the channel struct. Reverts for channelId >= nextChannelId. [F5]
    function getChannel(uint256 channelId) external view returns (Channel memory) {
        require(channelId < nextChannelId, "CHANNEL_NOT_FOUND"); // [F5]
        return channels[channelId];
    }

    function isVoucherConsumed(uint256 channelId, bytes32 requestId) external view returns (bool) {
        return consumedVouchers[channelId][requestId];
    }

    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function hashVoucher(
        uint256 channelId,
        bytes32 requestId,
        uint256 units,
        uint256 deadline
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(_VOUCHER_TYPEHASH, channelId, requestId, units, deadline)
        );
        return _hashTypedDataV4(structHash);
    }
}
