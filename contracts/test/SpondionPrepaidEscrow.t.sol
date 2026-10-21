// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../SpondionPrepaidEscrow.sol";
import "./MockUSDC.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SpondionPrepaidEscrow – comprehensive unit + regression tests
/// @dev All tests run against a local MockUSDC (6-decimal).
///      No network deploy, no real USDC, no real wallets.
contract SpondionPrepaidEscrowTest is Test {
    // ─── Fixture ────────────────────────────────────────────────────────────────
    uint256 constant GRACE = 1 hours;
    uint256 constant PRICE_PER_UNIT = 1_000; // 0.001 USDC
    uint256 constant PER_CALL_CAP = 10_000;  // 0.01 USDC (10 units)
    uint256 constant LIFETIME_CAP = 100_000; // 0.10 USDC
    uint256 constant DEPOSIT_AMOUNT = 50_000; // 0.05 USDC

    SpondionPrepaidEscrow escrow;
    MockUSDC usdc;

    address owner;
    uint256 ownerPk;
    address provider;
    address payout;
    address stranger;

    // ─── Helpers ────────────────────────────────────────────────────────────────

    function _openAndFund() internal returns (uint256 channelId) {
        vm.startPrank(owner);
        channelId = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        usdc.approve(address(escrow), DEPOSIT_AMOUNT);
        escrow.deposit(channelId, DEPOSIT_AMOUNT);
        vm.stopPrank();
    }

    function _sign(
        uint256 channelId,
        bytes32 requestId,
        uint256 units,
        uint256 deadline
    ) internal view returns (bytes memory sig) {
        bytes32 digest = escrow.hashVoucher(channelId, requestId, units, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    // ─── Setup ──────────────────────────────────────────────────────────────────

    function setUp() public {
        (owner, ownerPk) = makeAddrAndKey("owner");
        provider = makeAddr("provider");
        payout = makeAddr("payout");
        stranger = makeAddr("stranger");

        usdc = new MockUSDC(6);
        escrow = new SpondionPrepaidEscrow(address(usdc), GRACE);

        usdc.mint(owner, 1_000_000);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Section 1: Constructor
    // ─────────────────────────────────────────────────────────────────────────────

    function test_constructor_storesUSDC() public view {
        assertEq(address(escrow.usdc()), address(usdc));
    }

    function test_constructor_storesGrace() public view {
        assertEq(escrow.GRACE_DURATION(), GRACE);
    }

    function test_constructor_rejectsZeroUSDC() public {
        vm.expectRevert(bytes("USDC_ZERO"));
        new SpondionPrepaidEscrow(address(0), GRACE);
    }

    // [F1] grace == 0 now hits GRACE_TOO_SHORT
    function test_constructor_rejectsZeroGrace() public {
        vm.expectRevert(bytes("GRACE_TOO_SHORT"));
        new SpondionPrepaidEscrow(address(usdc), 0);
    }

    // [F1] Regression: grace above 30 days rejected
    function test_constructor_rejectsGraceTooLong() public {
        vm.expectRevert(bytes("GRACE_TOO_LONG"));
        new SpondionPrepaidEscrow(address(usdc), 30 days + 1);
    }

    // [F1] Regression: exactly 30 days accepted
    function test_constructor_acceptsMaxGrace() public {
        SpondionPrepaidEscrow e = new SpondionPrepaidEscrow(address(usdc), 30 days);
        assertEq(e.GRACE_DURATION(), 30 days);
    }

    // [F1] Regression: exactly 1 second accepted
    function test_constructor_acceptsMinGrace() public {
        SpondionPrepaidEscrow e = new SpondionPrepaidEscrow(address(usdc), 1);
        assertEq(e.GRACE_DURATION(), 1);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Section 2: openChannel
    // ─────────────────────────────────────────────────────────────────────────────

    function test_openChannel_incrementsId() public {
        vm.startPrank(owner);
        uint256 id0 = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        uint256 id1 = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        vm.stopPrank();

        assertEq(id0, 0);
        assertEq(id1, 1);
        assertEq(escrow.nextChannelId(), 2);
    }

    function test_openChannel_storesFields() public {
        vm.prank(owner);
        uint256 id = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);

        SpondionPrepaidEscrow.Channel memory ch = escrow.getChannel(id);
        assertEq(ch.owner, owner);
        assertEq(ch.provider, provider);
        assertEq(ch.payout, payout);
        assertEq(ch.signer, owner);
        assertEq(ch.pricePerUnit, PRICE_PER_UNIT);
        assertEq(ch.perCallCap, PER_CALL_CAP);
        assertEq(ch.lifetimeCap, LIFETIME_CAP);
        assertEq(ch.balance, 0);
        assertEq(ch.spent, 0);
        assertEq(uint8(ch.state), uint8(SpondionPrepaidEscrow.ChannelState.Active));
    }

    function test_openChannel_customSigner() public {
        address customSigner = makeAddr("customSigner");
        vm.prank(owner);
        uint256 id = escrow.openChannel(provider, payout, customSigner, PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        assertEq(escrow.getChannel(id).signer, customSigner);
    }

    function test_openChannel_emitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit SpondionPrepaidEscrow.ChannelOpened(
            0, owner, provider, payout, owner, PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP
        );
        vm.prank(owner);
        escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
    }

    function test_openChannel_rejectsZeroProvider() public {
        vm.prank(owner);
        vm.expectRevert(bytes("PROVIDER_ZERO"));
        escrow.openChannel(address(0), payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
    }

    function test_openChannel_rejectsZeroPayout() public {
        vm.prank(owner);
        vm.expectRevert(bytes("PAYOUT_ZERO"));
        escrow.openChannel(provider, address(0), address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
    }

    // [F3] Regression: payout == address(this) rejected
    function test_openChannel_rejectsPayoutIsEscrow() public {
        vm.prank(owner);
        vm.expectRevert(bytes("PAYOUT_IS_ESCROW"));
        escrow.openChannel(provider, address(escrow), address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
    }

    // [F3] Regression: payout as a normal contract wallet succeeds
    function test_openChannel_allowsContractWalletPayout() public {
        // Deploy a simple ERC1271 wallet and use it as payout — must succeed
        MockERC1271Wallet wallet = new MockERC1271Wallet(owner);
        vm.prank(owner);
        uint256 id = escrow.openChannel(provider, address(wallet), address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        assertEq(escrow.getChannel(id).payout, address(wallet));
    }

    function test_openChannel_rejectsZeroPrice() public {
        vm.prank(owner);
        vm.expectRevert(bytes("PRICE_ZERO"));
        escrow.openChannel(provider, payout, address(0), 0, PER_CALL_CAP, LIFETIME_CAP);
    }

    function test_openChannel_rejectsZeroPerCallCap() public {
        vm.prank(owner);
        vm.expectRevert(bytes("PER_CALL_CAP_ZERO"));
        escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, 0, LIFETIME_CAP);
    }

    function test_openChannel_rejectsZeroLifetimeCap() public {
        vm.prank(owner);
        vm.expectRevert(bytes("LIFETIME_CAP_ZERO"));
        escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, 0);
    }

    function test_openChannel_rejectsCapMismatch() public {
        vm.prank(owner);
        vm.expectRevert(bytes("CAP_MISMATCH"));
        escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, LIFETIME_CAP + 1, LIFETIME_CAP);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Section 3: deposit
    // ─────────────────────────────────────────────────────────────────────────────

    function test_deposit_transfersTokens() public {
        uint256 channelId = _openAndFund();
        assertEq(escrow.getChannel(channelId).balance, DEPOSIT_AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), DEPOSIT_AMOUNT);
        assertEq(escrow.totalLiabilities(), DEPOSIT_AMOUNT);
    }

    function test_deposit_emitsEvent() public {
        vm.startPrank(owner);
        uint256 channelId = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        usdc.approve(address(escrow), DEPOSIT_AMOUNT);
        vm.expectEmit(true, false, false, true);
        emit SpondionPrepaidEscrow.Deposited(channelId, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT);
        escrow.deposit(channelId, DEPOSIT_AMOUNT);
        vm.stopPrank();
    }

    function test_deposit_accumulatesBalance() public {
        vm.startPrank(owner);
        uint256 id = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        usdc.approve(address(escrow), DEPOSIT_AMOUNT * 2);
        escrow.deposit(id, DEPOSIT_AMOUNT);
        escrow.deposit(id, DEPOSIT_AMOUNT);
        vm.stopPrank();

        assertEq(escrow.getChannel(id).balance, DEPOSIT_AMOUNT * 2);
        assertEq(escrow.totalLiabilities(), DEPOSIT_AMOUNT * 2);
    }

    function test_deposit_rejectsNonOwner() public {
        vm.startPrank(owner);
        uint256 id = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        vm.stopPrank();

        usdc.mint(stranger, DEPOSIT_AMOUNT);
        vm.startPrank(stranger);
        usdc.approve(address(escrow), DEPOSIT_AMOUNT);
        vm.expectRevert(bytes("NOT_OWNER"));
        escrow.deposit(id, DEPOSIT_AMOUNT);
        vm.stopPrank();
    }

    function test_deposit_rejectsZeroAmount() public {
        vm.startPrank(owner);
        uint256 id = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        vm.expectRevert(bytes("AMOUNT_ZERO"));
        escrow.deposit(id, 0);
        vm.stopPrank();
    }

    function test_deposit_rejectsClosedChannel() public {
        uint256 id = _openAndFund();
        vm.prank(owner);
        escrow.requestClose(id);
        vm.warp(block.timestamp + GRACE + 1);
        vm.prank(owner);
        escrow.finalizeRefund(id);

        usdc.mint(owner, DEPOSIT_AMOUNT);
        vm.startPrank(owner);
        usdc.approve(address(escrow), DEPOSIT_AMOUNT);
        vm.expectRevert(bytes("NOT_ACTIVE"));
        escrow.deposit(id, DEPOSIT_AMOUNT);
        vm.stopPrank();
    }

    function test_deposit_rejectsFeeOnTransferToken() public {
        address feeCollector = makeAddr("feeCollector");
        FeeOnTransferToken feeToken = new FeeOnTransferToken(6, feeCollector);
        SpondionPrepaidEscrow escrowFee = new SpondionPrepaidEscrow(address(feeToken), GRACE);

        feeToken.mint(owner, 1_000_000);
        vm.startPrank(owner);
        uint256 id = escrowFee.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        feeToken.approve(address(escrowFee), DEPOSIT_AMOUNT);
        vm.expectRevert(bytes("BAD_TOKEN_DELTA"));
        escrowFee.deposit(id, DEPOSIT_AMOUNT);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Section 4: settleUsage
    // ─────────────────────────────────────────────────────────────────────────────

    function test_settle_happyPath() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-1");
        uint256 units = 5;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(id, reqId, units, deadline);

        vm.prank(provider);
        escrow.settleUsage(id, reqId, units, deadline, sig);

        uint256 expected = units * PRICE_PER_UNIT;
        SpondionPrepaidEscrow.Channel memory ch = escrow.getChannel(id);
        assertEq(ch.balance, DEPOSIT_AMOUNT - expected);
        assertEq(ch.spent, expected);
        assertEq(escrow.providerCredit(payout), expected);
        assertEq(escrow.totalLiabilities(), DEPOSIT_AMOUNT);
        assertTrue(escrow.isVoucherConsumed(id, reqId));
    }

    function test_settle_emitsEvent() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-emit");
        uint256 units = 3;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(id, reqId, units, deadline);

        vm.expectEmit(true, true, false, true);
        emit SpondionPrepaidEscrow.UsageSettled(id, reqId, units, units * PRICE_PER_UNIT);

        vm.prank(provider);
        escrow.settleUsage(id, reqId, units, deadline, sig);
    }

    function test_settle_rejectsNonProvider() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-2");
        bytes memory sig = _sign(id, reqId, 1, block.timestamp + 1 hours);

        vm.prank(stranger);
        vm.expectRevert(bytes("NOT_PROVIDER"));
        escrow.settleUsage(id, reqId, 1, block.timestamp + 1 hours, sig);
    }

    // [F4] Regression: block.timestamp == deadline now accepted (inclusive)
    function test_settle_acceptsDeadlineEqualNow() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-deadline-equal");
        uint256 deadline = block.timestamp; // exactly now
        bytes memory sig = _sign(id, reqId, 1, deadline);

        vm.prank(provider);
        escrow.settleUsage(id, reqId, 1, deadline, sig); // must not revert
        assertTrue(escrow.isVoucherConsumed(id, reqId));
    }

    // [F4] Regression: block.timestamp == deadline - 1 accepted
    function test_settle_acceptsDeadlineMinusOne() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-deadline-minus1");
        uint256 deadline = block.timestamp + 10;
        vm.warp(block.timestamp + 9); // now == deadline - 1
        bytes memory sig = _sign(id, reqId, 1, deadline);

        vm.prank(provider);
        escrow.settleUsage(id, reqId, 1, deadline, sig);
        assertTrue(escrow.isVoucherConsumed(id, reqId));
    }

    // [F4] Regression: block.timestamp == deadline + 1 reverts
    function test_settle_rejectsDeadlinePlusOne() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-deadline-plus1");
        uint256 deadline = block.timestamp;
        vm.warp(block.timestamp + 1); // now == deadline + 1
        bytes memory sig = _sign(id, reqId, 1, deadline);

        vm.prank(provider);
        vm.expectRevert(bytes("VOUCHER_EXPIRED"));
        escrow.settleUsage(id, reqId, 1, deadline, sig);
    }

    function test_settle_rejectsExpiredVoucher() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-expired");
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _sign(id, reqId, 1, deadline);

        vm.prank(provider);
        vm.expectRevert(bytes("VOUCHER_EXPIRED"));
        escrow.settleUsage(id, reqId, 1, deadline, sig);
    }

    function test_settle_rejectsZeroRequestId() public {
        uint256 id = _openAndFund();
        bytes memory sig = _sign(id, bytes32(0), 1, block.timestamp + 1 hours);

        vm.prank(provider);
        vm.expectRevert(bytes("REQUEST_ID_ZERO"));
        escrow.settleUsage(id, bytes32(0), 1, block.timestamp + 1 hours, sig);
    }

    function test_settle_rejectsZeroUnits() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-zero");
        bytes memory sig = _sign(id, reqId, 0, block.timestamp + 1 hours);

        vm.prank(provider);
        vm.expectRevert(bytes("UNITS_ZERO"));
        escrow.settleUsage(id, reqId, 0, block.timestamp + 1 hours, sig);
    }

    function test_settle_rejectsReplayedVoucher() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-replay");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(id, reqId, 1, deadline);

        vm.startPrank(provider);
        escrow.settleUsage(id, reqId, 1, deadline, sig);
        vm.expectRevert(bytes("VOUCHER_USED"));
        escrow.settleUsage(id, reqId, 1, deadline, sig);
        vm.stopPrank();
    }

    // Regression: same requestId with a freshly signed signature (different deadline) still
    // reverts because the requestId bit is consumed, not the (requestId, deadline) tuple.
    function test_settle_sameRequestIdFreshSigReverts() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-same-id-fresh");
        uint256 deadline1 = block.timestamp + 1 hours;
        bytes memory sig1 = _sign(id, reqId, 1, deadline1);

        vm.prank(provider);
        escrow.settleUsage(id, reqId, 1, deadline1, sig1);

        // Now sign the same requestId with a fresh deadline — must still be rejected
        uint256 deadline2 = block.timestamp + 2 hours;
        bytes memory sig2 = _sign(id, reqId, 1, deadline2);
        vm.prank(provider);
        vm.expectRevert(bytes("VOUCHER_USED"));
        escrow.settleUsage(id, reqId, 1, deadline2, sig2);
    }

    // Regression: replay after top-up — consumed voucher stays consumed even when the
    // channel balance is replenished.
    function test_settle_replayAfterTopUp() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-topup-replay");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(id, reqId, 1, deadline);

        vm.prank(provider);
        escrow.settleUsage(id, reqId, 1, deadline, sig);

        // Top-up
        usdc.mint(owner, DEPOSIT_AMOUNT);
        vm.startPrank(owner);
        usdc.approve(address(escrow), DEPOSIT_AMOUNT);
        escrow.deposit(id, DEPOSIT_AMOUNT);
        vm.stopPrank();

        vm.prank(provider);
        vm.expectRevert(bytes("VOUCHER_USED"));
        escrow.settleUsage(id, reqId, 1, deadline, sig);
    }

    function test_settle_rejectsPerCallCapExceeded() public {
        uint256 id = _openAndFund();
        uint256 units = 11; // 11 * 1000 = 11_000 > PER_CALL_CAP
        bytes32 reqId = keccak256("req-cap");
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(id, reqId, units, deadline);

        vm.prank(provider);
        vm.expectRevert(bytes("PER_CALL_CAP_EXCEEDED"));
        escrow.settleUsage(id, reqId, units, deadline, sig);
    }

    function test_settle_rejectsLifetimeCapExceeded() public {
        uint256 id = _openAndFund();
        usdc.mint(owner, 1_000_000);
        vm.startPrank(owner);
        usdc.approve(address(escrow), 1_000_000);
        escrow.deposit(id, 1_000_000);
        vm.stopPrank();

        for (uint256 i = 0; i < 10; i++) {
            bytes32 reqId = keccak256(abi.encodePacked("req-lifetime", i));
            bytes memory sig = _sign(id, reqId, 10, block.timestamp + 1 hours);
            vm.prank(provider);
            escrow.settleUsage(id, reqId, 10, block.timestamp + 1 hours, sig);
        }
        bytes32 lastReq = keccak256("req-lifetime-over");
        bytes memory sig = _sign(id, lastReq, 1, block.timestamp + 1 hours);
        vm.prank(provider);
        vm.expectRevert(bytes("LIFETIME_CAP_EXCEEDED"));
        escrow.settleUsage(id, lastReq, 1, block.timestamp + 1 hours, sig);
    }

    function test_settle_rejectsInsufficientBalance() public {
        vm.prank(owner);
        uint256 id = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        bytes32 reqId = keccak256("req-nofunds");
        bytes memory sig = _sign(id, reqId, 1, block.timestamp + 1 hours);

        vm.prank(provider);
        vm.expectRevert(bytes("INSUFFICIENT_CHANNEL_BALANCE"));
        escrow.settleUsage(id, reqId, 1, block.timestamp + 1 hours, sig);
    }

    function test_settle_rejectsBadSignature() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-badsig");
        (, uint256 strangerPk) = makeAddrAndKey("stranger");
        bytes32 digest = escrow.hashVoucher(id, reqId, 1, block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(strangerPk, digest);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.prank(provider);
        vm.expectRevert(bytes("INVALID_SIGNATURE"));
        escrow.settleUsage(id, reqId, 1, block.timestamp + 1 hours, badSig);
    }

    function test_settle_duringClosingBeforeRefundWindow() public {
        uint256 id = _openAndFund();
        vm.prank(owner);
        escrow.requestClose(id);

        bytes32 reqId = keccak256("req-closing");
        uint256 deadline = block.timestamp + GRACE - 1;
        bytes memory sig = _sign(id, reqId, 1, deadline);

        vm.warp(block.timestamp + GRACE / 2);
        vm.prank(provider);
        escrow.settleUsage(id, reqId, 1, deadline, sig);
    }

    function test_settle_rejectsAfterRefundWindowReached() public {
        uint256 id = _openAndFund();
        vm.prank(owner);
        escrow.requestClose(id);

        bytes32 reqId = keccak256("req-after-grace");
        uint256 deadline = block.timestamp + GRACE + 2 hours;
        bytes memory sig = _sign(id, reqId, 1, deadline);

        vm.warp(block.timestamp + GRACE);
        vm.prank(provider);
        vm.expectRevert(bytes("REFUND_WINDOW_REACHED"));
        escrow.settleUsage(id, reqId, 1, deadline, sig);
    }

    // Regression: ERC1271 signer (contract wallet).
    // OZ5 SignatureChecker uses staticcall — no state mutation in isValidSignature is expected.
    function test_settle_erc1271Signer() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(owner);

        vm.prank(owner);
        uint256 id = escrow.openChannel(provider, payout, address(wallet), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        usdc.mint(owner, DEPOSIT_AMOUNT);
        vm.startPrank(owner);
        usdc.approve(address(escrow), DEPOSIT_AMOUNT);
        escrow.deposit(id, DEPOSIT_AMOUNT);
        vm.stopPrank();

        bytes32 reqId = keccak256("req-1271");
        uint256 deadline = block.timestamp + 1 hours;
        // Sign the EIP-712 digest with owner's key (the wallet verifies owner's ECDSA sig)
        bytes32 digest = escrow.hashVoucher(id, reqId, 1, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(provider);
        escrow.settleUsage(id, reqId, 1, deadline, sig);
        assertTrue(escrow.isVoucherConsumed(id, reqId));
    }

    // Regression: wrong-chain domain — signature made for chainId=9999 must be rejected.
    function test_settle_wrongChainDomainReverts() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-wrong-chain");
        uint256 deadline = block.timestamp + 1 hours;

        // Build a digest as if the contract were on chain 9999
        bytes32 domainSep = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("SpondionPrepaidEscrow")),
            keccak256(bytes("1")),
            uint256(9999), // wrong chain
            address(escrow)
        ));
        bytes32 structHash = keccak256(abi.encode(
            keccak256("UsageVoucher(uint256 channelId,bytes32 requestId,uint256 units,uint256 deadline)"),
            id, reqId, uint256(1), deadline
        ));
        bytes32 badDigest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, badDigest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(provider);
        vm.expectRevert(bytes("INVALID_SIGNATURE"));
        escrow.settleUsage(id, reqId, 1, deadline, sig);
    }

    // Regression: wrong-escrow domain — signature bound to a different escrow address.
    function test_settle_wrongEscrowDomainReverts() public {
        // Deploy a second escrow to get a different address
        SpondionPrepaidEscrow escrow2 = new SpondionPrepaidEscrow(address(usdc), GRACE);

        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-wrong-escrow");
        uint256 deadline = block.timestamp + 1 hours;

        // Sign with escrow2's domain
        bytes32 digest2 = escrow2.hashVoucher(id, reqId, 1, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest2);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(provider);
        vm.expectRevert(bytes("INVALID_SIGNATURE"));
        escrow.settleUsage(id, reqId, 1, deadline, sig);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Section 5: requestClose
    // ─────────────────────────────────────────────────────────────────────────────

    // [F2] refundAvailableAt is now uint256; test that it stores correctly
    function test_requestClose_setsState() public {
        uint256 id = _openAndFund();
        vm.prank(owner);
        escrow.requestClose(id);

        SpondionPrepaidEscrow.Channel memory ch = escrow.getChannel(id);
        assertEq(uint8(ch.state), uint8(SpondionPrepaidEscrow.ChannelState.Closing));
        assertEq(ch.refundAvailableAt, block.timestamp + GRACE);
    }

    function test_requestClose_emitsEvent() public {
        uint256 id = _openAndFund();
        vm.expectEmit(true, false, false, true);
        emit SpondionPrepaidEscrow.ClosingRequested(id, block.timestamp + GRACE);
        vm.prank(owner);
        escrow.requestClose(id);
    }

    function test_requestClose_rejectsNonOwner() public {
        uint256 id = _openAndFund();
        vm.prank(stranger);
        vm.expectRevert(bytes("NOT_OWNER"));
        escrow.requestClose(id);
    }

    function test_requestClose_rejectsAlreadyClosing() public {
        uint256 id = _openAndFund();
        vm.prank(owner);
        escrow.requestClose(id);
        vm.prank(owner);
        vm.expectRevert(bytes("NOT_ACTIVE"));
        escrow.requestClose(id);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Section 6: finalizeRefund
    // ─────────────────────────────────────────────────────────────────────────────

    function test_finalizeRefund_returnsBalance() public {
        uint256 id = _openAndFund();
        uint256 ownerBefore = usdc.balanceOf(owner);

        vm.prank(owner);
        escrow.requestClose(id);
        vm.warp(block.timestamp + GRACE + 1);
        vm.prank(owner);
        escrow.finalizeRefund(id);

        assertEq(usdc.balanceOf(owner), ownerBefore + DEPOSIT_AMOUNT);
        assertEq(escrow.totalLiabilities(), 0);

        SpondionPrepaidEscrow.Channel memory ch = escrow.getChannel(id);
        assertEq(uint8(ch.state), uint8(SpondionPrepaidEscrow.ChannelState.Closed));
        assertEq(ch.balance, 0);
    }

    function test_finalizeRefund_partialAfterSettle() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-partial");
        bytes memory sig = _sign(id, reqId, 3, block.timestamp + 1 hours);
        vm.prank(provider);
        escrow.settleUsage(id, reqId, 3, block.timestamp + 1 hours, sig);

        uint256 settled = 3 * PRICE_PER_UNIT;
        uint256 remainingBalance = DEPOSIT_AMOUNT - settled;
        uint256 ownerBefore = usdc.balanceOf(owner);

        vm.prank(owner);
        escrow.requestClose(id);
        vm.warp(block.timestamp + GRACE + 1);
        vm.prank(owner);
        escrow.finalizeRefund(id);

        assertEq(usdc.balanceOf(owner), ownerBefore + remainingBalance);
        assertEq(escrow.totalLiabilities(), settled); // provider credit remains
    }

    function test_finalizeRefund_rejectsNotOwner() public {
        uint256 id = _openAndFund();
        vm.prank(owner);
        escrow.requestClose(id);
        vm.warp(block.timestamp + GRACE + 1);

        vm.prank(stranger);
        vm.expectRevert(bytes("NOT_OWNER"));
        escrow.finalizeRefund(id);
    }

    function test_finalizeRefund_rejectsNotClosing() public {
        uint256 id = _openAndFund();
        vm.prank(owner);
        vm.expectRevert(bytes("NOT_CLOSING"));
        escrow.finalizeRefund(id);
    }

    function test_finalizeRefund_rejectsGraceNotElapsed() public {
        uint256 id = _openAndFund();
        vm.prank(owner);
        escrow.requestClose(id);
        vm.prank(owner);
        vm.expectRevert(bytes("GRACE_NOT_ELAPSED"));
        escrow.finalizeRefund(id);
    }

    function test_finalizeRefund_zeroBalance() public {
        vm.prank(owner);
        uint256 id = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        vm.prank(owner);
        escrow.requestClose(id);
        vm.warp(block.timestamp + GRACE + 1);

        uint256 ownerBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        escrow.finalizeRefund(id);
        assertEq(usdc.balanceOf(owner), ownerBefore);
    }

    // Regression: exact close boundary — finalizeRefund at block.timestamp == refundAvailableAt
    // must succeed (>= is inclusive).
    function test_finalizeRefund_exactBoundary() public {
        uint256 id = _openAndFund();
        vm.prank(owner);
        escrow.requestClose(id);
        uint256 refundAt = block.timestamp + GRACE;

        vm.warp(refundAt); // exactly == refundAvailableAt
        vm.prank(owner);
        escrow.finalizeRefund(id); // must not revert
        assertEq(uint8(escrow.getChannel(id).state), uint8(SpondionPrepaidEscrow.ChannelState.Closed));
    }

    // Regression: failed outgoing refund transfer preserves channel balance (SafeERC20 reverts
    // so the whole tx reverts — channel stays Closing, balance intact).
    function test_finalizeRefund_failedTransferPreservesState() public {
        RevertOnTransferToken revToken = new RevertOnTransferToken(6);
        SpondionPrepaidEscrow escrowRev = new SpondionPrepaidEscrow(address(revToken), GRACE);

        revToken.mint(owner, DEPOSIT_AMOUNT);
        vm.startPrank(owner);
        uint256 id = escrowRev.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        revToken.approve(address(escrowRev), DEPOSIT_AMOUNT);
        escrowRev.deposit(id, DEPOSIT_AMOUNT);
        escrowRev.requestClose(id);
        vm.stopPrank();

        vm.warp(block.timestamp + GRACE + 1);

        // Enable revert mode so outgoing transfer fails
        revToken.setRevertOutgoing(true);

        vm.prank(owner);
        vm.expectRevert(); // SafeERC20 propagates the revert
        escrowRev.finalizeRefund(id);

        // State must be unchanged
        SpondionPrepaidEscrow.Channel memory ch = escrowRev.getChannel(id);
        assertEq(uint8(ch.state), uint8(SpondionPrepaidEscrow.ChannelState.Closing));
        assertEq(ch.balance, DEPOSIT_AMOUNT);
        assertEq(escrowRev.totalLiabilities(), DEPOSIT_AMOUNT);
    }

    // Regression: failed provider withdrawal preserves credit (SafeERC20 reverts so credit
    // is rolled back to its pre-call value).
    function test_withdraw_failedTransferPreservesCredit() public {
        RevertOnTransferToken revToken = new RevertOnTransferToken(6);
        SpondionPrepaidEscrow escrowRev = new SpondionPrepaidEscrow(address(revToken), GRACE);

        revToken.mint(owner, DEPOSIT_AMOUNT);
        vm.startPrank(owner);
        uint256 id = escrowRev.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        revToken.approve(address(escrowRev), DEPOSIT_AMOUNT);
        escrowRev.deposit(id, DEPOSIT_AMOUNT);
        vm.stopPrank();

        // Settle so payout has credit
        bytes32 reqId = keccak256("req-rev-w");
        bytes32 digest = escrowRev.hashVoucher(id, reqId, 1, block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(provider);
        escrowRev.settleUsage(id, reqId, 1, block.timestamp + 1 hours, sig);

        uint256 creditBefore = escrowRev.providerCredit(payout);
        uint256 liabBefore   = escrowRev.totalLiabilities();
        assertGt(creditBefore, 0);

        // Enable revert mode so outgoing transfer fails
        revToken.setRevertOutgoing(true);

        vm.prank(payout);
        vm.expectRevert();
        escrowRev.withdraw();

        // Credit and liabilities must be unchanged
        assertEq(escrowRev.providerCredit(payout), creditBefore);
        assertEq(escrowRev.totalLiabilities(), liabBefore);
    }

    // Regression: reentrancy via a callback token.  The deposit nonReentrant guard must block
    // a reentrant deposit call from within a malicious transferFrom.
    function test_deposit_callbackReentrancyBlocked() public {
        ReentrantDepositToken rToken = new ReentrantDepositToken(6);
        SpondionPrepaidEscrow escrowRe = new SpondionPrepaidEscrow(address(rToken), GRACE);

        rToken.mint(owner, DEPOSIT_AMOUNT * 2);
        vm.startPrank(owner);
        uint256 id = escrowRe.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        rToken.approve(address(escrowRe), DEPOSIT_AMOUNT * 2);
        // Tell the token to try a reentrant deposit call
        rToken.setReentrancyTarget(address(escrowRe), id, DEPOSIT_AMOUNT);

        // [Audit F6] Assert the exact OZ5 ReentrancyGuardReentrantCall selector so the test
        // cannot pass silently if the revert comes from NOT_OWNER or any other reason.
        // selector = bytes4(keccak256("ReentrancyGuardReentrantCall()")) = 0x3ee5aeb5
        vm.expectRevert(abi.encodeWithSelector(bytes4(0x3ee5aeb5)));
        escrowRe.deposit(id, DEPOSIT_AMOUNT);
        vm.stopPrank();
    }

    // Regression: no-return token (missing bool on transfer) — SafeERC20 must handle it.
    // We verify the deposit succeeds when the token is otherwise correct.
    function test_deposit_noReturnTokenSucceeds() public {
        NoReturnToken nrToken = new NoReturnToken(6);
        SpondionPrepaidEscrow escrowNR = new SpondionPrepaidEscrow(address(nrToken), GRACE);

        nrToken.mint(owner, DEPOSIT_AMOUNT);
        vm.startPrank(owner);
        uint256 id = escrowNR.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        nrToken.approve(address(escrowNR), DEPOSIT_AMOUNT);
        escrowNR.deposit(id, DEPOSIT_AMOUNT); // must succeed via SafeERC20
        vm.stopPrank();

        assertEq(escrowNR.getChannel(id).balance, DEPOSIT_AMOUNT);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Section 7: withdraw (provider)
    // ─────────────────────────────────────────────────────────────────────────────

    function test_withdraw_happyPath() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-w1");
        bytes memory sig = _sign(id, reqId, 5, block.timestamp + 1 hours);
        vm.prank(provider);
        escrow.settleUsage(id, reqId, 5, block.timestamp + 1 hours, sig);

        uint256 credit = 5 * PRICE_PER_UNIT;
        uint256 payoutBefore = usdc.balanceOf(payout);
        vm.prank(payout);
        escrow.withdraw();

        assertEq(usdc.balanceOf(payout), payoutBefore + credit);
        assertEq(escrow.providerCredit(payout), 0);
        assertEq(escrow.totalLiabilities(), DEPOSIT_AMOUNT - credit);
    }

    function test_withdraw_emitsEvent() public {
        uint256 id = _openAndFund();
        bytes32 reqId = keccak256("req-w-emit");
        bytes memory sig = _sign(id, reqId, 2, block.timestamp + 1 hours);
        vm.prank(provider);
        escrow.settleUsage(id, reqId, 2, block.timestamp + 1 hours, sig);

        uint256 credit = 2 * PRICE_PER_UNIT;
        vm.expectEmit(true, false, false, true);
        emit SpondionPrepaidEscrow.ProviderWithdrawn(payout, credit);
        vm.prank(payout);
        escrow.withdraw();
    }

    function test_withdraw_rejectsNoCredit() public {
        vm.prank(payout);
        vm.expectRevert(bytes("NO_CREDIT"));
        escrow.withdraw();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Section 8: getChannel guard [F5]
    // ─────────────────────────────────────────────────────────────────────────────

    // [F5] Regression: getChannel(0) before any channel is opened must revert
    function test_getChannel_rejectsNonexistentId() public {
        vm.expectRevert(bytes("CHANNEL_NOT_FOUND"));
        escrow.getChannel(0);
    }

    // [F5] Regression: getChannel(nextChannelId) must revert (off-by-one guard)
    function test_getChannel_rejectsNextChannelId() public {
        vm.prank(owner);
        escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        // nextChannelId is now 1; channel 1 doesn't exist
        vm.expectRevert(bytes("CHANNEL_NOT_FOUND"));
        escrow.getChannel(1);
    }

    // [F5] Regression: getChannel(type(uint256).max) must revert
    function test_getChannel_rejectsMaxUint() public {
        vm.expectRevert(bytes("CHANNEL_NOT_FOUND"));
        escrow.getChannel(type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Section 9: Invariant-style multi-op scenario
    // ─────────────────────────────────────────────────────────────────────────────

    function test_invariant_solvency_scenario() public {
        uint256 id = _openAndFund();

        for (uint256 i = 0; i < 3; i++) {
            bytes32 reqId = keccak256(abi.encodePacked("req-inv", i));
            bytes memory sig = _sign(id, reqId, 2, block.timestamp + 1 hours);
            vm.prank(provider);
            escrow.settleUsage(id, reqId, 2, block.timestamp + 1 hours, sig);
        }

        assertGe(usdc.balanceOf(address(escrow)), escrow.totalLiabilities(), "Insolvent before withdraw");

        vm.prank(payout);
        escrow.withdraw();

        assertGe(usdc.balanceOf(address(escrow)), escrow.totalLiabilities(), "Insolvent after withdraw");

        vm.prank(owner);
        escrow.requestClose(id);
        vm.warp(block.timestamp + GRACE + 1);
        vm.prank(owner);
        escrow.finalizeRefund(id);

        assertEq(escrow.totalLiabilities(), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Section 10: Fuzz tests
    // ─────────────────────────────────────────────────────────────────────────────

    function testFuzz_deposit(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000);
        usdc.mint(owner, amount);

        vm.startPrank(owner);
        uint256 id = escrow.openChannel(provider, payout, address(0), 1, amount, amount);
        usdc.approve(address(escrow), amount);
        escrow.deposit(id, amount);
        vm.stopPrank();

        assertEq(escrow.getChannel(id).balance, amount);
        assertEq(escrow.totalLiabilities(), amount);
        assertEq(usdc.balanceOf(address(escrow)), amount);
    }

    function testFuzz_settle(uint256 units) public {
        units = bound(units, 1, 10);
        uint256 id = _openAndFund();

        bytes32 reqId = keccak256(abi.encodePacked("fuzz-req", units));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(id, reqId, units, deadline);

        vm.prank(provider);
        escrow.settleUsage(id, reqId, units, deadline, sig);

        assertEq(escrow.getChannel(id).spent, units * PRICE_PER_UNIT);
        assertEq(escrow.providerCredit(payout), units * PRICE_PER_UNIT);
    }

    // Regression: multi-operation conservation fuzz.
    // After N deposits, M settlements, provider withdraw, and owner refund,
    // totalLiabilities must be zero and the contract must hold zero tokens.
    function testFuzz_multiOpConservation(uint8 nDeposits, uint8 nSettles) public {
        nDeposits = uint8(bound(nDeposits, 1, 5));
        nSettles  = uint8(bound(nSettles,  0, 5));

        uint256 id;
        vm.startPrank(owner);
        id = escrow.openChannel(provider, payout, address(0), PRICE_PER_UNIT, PER_CALL_CAP, LIFETIME_CAP);
        vm.stopPrank();

        // Deposits
        uint256 totalDeposited;
        for (uint256 i = 0; i < nDeposits; i++) {
            usdc.mint(owner, DEPOSIT_AMOUNT);
            vm.startPrank(owner);
            usdc.approve(address(escrow), DEPOSIT_AMOUNT);
            escrow.deposit(id, DEPOSIT_AMOUNT);
            vm.stopPrank();
            totalDeposited += DEPOSIT_AMOUNT;
        }

        // Settle up to nSettles calls, each 1 unit, respecting lifetimeCap
        uint256 totalSettled;
        for (uint256 i = 0; i < nSettles; i++) {
            uint256 amount = PRICE_PER_UNIT;
            if (totalSettled + amount > LIFETIME_CAP) break;
            if (totalDeposited - totalSettled < amount) break;

            bytes32 reqId = keccak256(abi.encodePacked("fuzz-multi", i));
            uint256 deadline = block.timestamp + 1 hours;
            bytes memory sig = _sign(id, reqId, 1, deadline);
            vm.prank(provider);
            escrow.settleUsage(id, reqId, 1, deadline, sig);
            totalSettled += amount;
        }

        // Solvency invariant mid-flight
        assertGe(usdc.balanceOf(address(escrow)), escrow.totalLiabilities(), "Insolvent mid-flight");

        // Provider withdraws all credit
        if (escrow.providerCredit(payout) > 0) {
            vm.prank(payout);
            escrow.withdraw();
        }

        // Owner refunds
        vm.prank(owner);
        escrow.requestClose(id);
        vm.warp(block.timestamp + GRACE + 1);
        vm.prank(owner);
        escrow.finalizeRefund(id);

        assertEq(escrow.totalLiabilities(), 0, "Non-zero liabilities at end");
        assertEq(usdc.balanceOf(address(escrow)), 0, "Non-zero contract balance at end");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helper contracts
// ─────────────────────────────────────────────────────────────────────────────

/// @notice Mock ERC1271 wallet that validates owner's ECDSA signatures.
contract MockERC1271Wallet is IERC1271 {
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        address recovered = ECDSA.recover(hash, signature);
        if (recovered == owner) {
            return IERC1271.isValidSignature.selector; // 0x1626ba7e
        }
        return bytes4(0xffffffff);
    }
}

/// @notice Token that selectively reverts on outgoing safeTransfer to test failed-transfer
/// state preservation.  transferFrom always succeeds (needed for deposits).
contract RevertOnTransferToken is ERC20 {
    uint8 private immutable _dec;
    bool public revertOutgoing;

    constructor(uint8 decimals_) ERC20("RevertToken", "RVRT") {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setRevertOutgoing(bool v) external { revertOutgoing = v; }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (revertOutgoing) revert("TRANSFER_DISABLED");
        return super.transfer(to, amount);
    }
}

/// @notice Token whose transferFrom triggers a reentrant call into escrow.deposit.
contract ReentrantDepositToken is ERC20 {
    uint8 private immutable _dec;
    address public escrowTarget;
    uint256 public targetChannelId;
    uint256 public reentrancyAmount;

    constructor(uint8 decimals_) ERC20("ReentrantToken", "RENT") {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function setReentrancyTarget(address _escrow, uint256 _channelId, uint256 _amount) external {
        escrowTarget = _escrow;
        targetChannelId = _channelId;
        reentrancyAmount = _amount;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        // Transfer first, then attempt reentrant deposit
        bool ok = super.transferFrom(from, to, amount);
        if (escrowTarget != address(0)) {
            // This reentrant call must be blocked by ReentrancyGuard
            SpondionPrepaidEscrow(escrowTarget).deposit(targetChannelId, reentrancyAmount);
        }
        return ok;
    }
}

/// @notice ERC-20 that omits the bool return value on transfer/transferFrom
/// (like early USDT). SafeERC20 must handle this gracefully.
contract NoReturnToken {
    uint8 private immutable _dec;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 decimals_) {
        _dec = decimals_;
    }

    function decimals() public view returns (uint8) { return _dec; }
    function totalSupply() public view returns (uint256) { return _totalSupply; }
    function balanceOf(address a) public view returns (uint256) { return _balances[a]; }
    function allowance(address o, address s) public view returns (uint256) { return _allowances[o][s]; }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
        _totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    // NOTE: intentionally no return value to mimic non-standard tokens
    function transfer(address to, uint256 amount) public {
        require(_balances[msg.sender] >= amount, "insufficient");
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public {
        require(_balances[from] >= amount, "insufficient");
        require(_allowances[from][msg.sender] >= amount, "allowance");
        _allowances[from][msg.sender] -= amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
    }
}
