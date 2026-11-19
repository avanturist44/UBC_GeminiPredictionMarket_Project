// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {TipEscrow} from "../src/TipEscrow.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
interface Vm { function prank(address) external; function startPrank(address) external; function stopPrank() external; function warp(uint256) external; function expectRevert() external; function chainId(uint256) external; }
contract MockUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
contract TipEscrowTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockUSDC token; TipEscrow escrow;
    address author = address(11); address alice = address(12); address bob = address(13);
    bytes32 constant ID = keccak256("thesis"); bytes32 constant MARKET = keccak256("market");
    uint64 expiry;
    function setUp() public {
        token = new MockUSDC(); escrow = new TipEscrow(address(token), address(this), address(this));
        expiry = uint64(block.timestamp + 900);
        escrow.registerThesis(ID, author, MARKET, true, keccak256("content"), expiry);
        token.mint(alice, 20e6); token.mint(bob, 20e6);
        vm.prank(alice); token.approve(address(escrow), type(uint256).max);
        vm.prank(bob); token.approve(address(escrow), type(uint256).max);
    }
    function deposit(address who, uint256 amount, bytes32 request) internal { vm.prank(who); escrow.tip(ID, amount, request); }
    function testWinnerPaysOnlyAuthorAndCannotPayTwice() public {
        deposit(alice, 2e6, bytes32(uint256(1))); deposit(bob, 3e6, bytes32(uint256(2)));
        vm.warp(expiry); escrow.reportOutcome(MARKET, true);
        vm.prank(bob); escrow.settle(ID);
        require(token.balanceOf(author) == 5e6 && token.balanceOf(address(escrow)) == 0);
        vm.expectRevert(); escrow.settle(ID);
        vm.expectRevert(); escrow.refund(ID, alice);
    }
    function testWrongRefundsOriginalTippersOnly() public {
        deposit(alice, 2e6, bytes32(uint256(1))); deposit(bob, 3e6, bytes32(uint256(2)));
        vm.warp(expiry); escrow.reportOutcome(MARKET, false);
        vm.expectRevert(); escrow.settle(ID);
        escrow.refund(ID, alice); escrow.refund(ID, bob);
        require(token.balanceOf(alice) == 20e6 && token.balanceOf(bob) == 20e6);
        vm.expectRevert(); escrow.refund(ID, alice);
    }
    function testVoidRefunds() public {
        deposit(alice, 1e6, bytes32(uint256(1))); vm.warp(expiry); escrow.reportVoid(MARKET);
        vm.expectRevert(); escrow.settle(ID); escrow.refund(ID, alice);
        require(token.balanceOf(alice) == 20e6);
    }
    function testTimeoutThenLateOutcomeCannotDoubleSpendRefunds() public {
        deposit(alice, 2e6, bytes32(uint256(1))); deposit(bob, 1e6, bytes32(uint256(2)));
        vm.warp(uint256(expiry) + 7 days + 1); escrow.refund(ID, alice);
        escrow.reportOutcome(MARKET, true); escrow.settle(ID);
        require(token.balanceOf(author) == 1e6 && token.balanceOf(alice) == 20e6);
    }
    function testAccessAndEarlyOutcomeGuards() public {
        vm.prank(alice); vm.expectRevert(); escrow.registerThesis(keccak256("other"), author, MARKET, true, keccak256("c"), expiry);
        vm.expectRevert(); escrow.reportOutcome(MARKET, true);
        vm.warp(expiry); vm.prank(alice); vm.expectRevert(); escrow.reportOutcome(MARKET, true);
        escrow.reportOutcome(MARKET, true); vm.expectRevert(); escrow.reportVoid(MARKET);
    }
    function testDuplicateRequestAndCumulativeCap() public {
        deposit(alice, 3e6, bytes32(uint256(1)));
        vm.prank(alice); vm.expectRevert(); escrow.tip(ID, 1e6, bytes32(uint256(1)));
        vm.prank(alice); vm.expectRevert(); escrow.tip(ID, 3e6, bytes32(uint256(2)));
        deposit(alice, 2e6, bytes32(uint256(3)));
        require(token.balanceOf(address(escrow)) == 5e6);
    }
    function testRegistrationAndTipGuards() public {
        vm.expectRevert(); escrow.registerThesis(ID, author, MARKET, true, keccak256("c"), expiry);
        vm.expectRevert(); escrow.registerThesis(keccak256("other"), author, MARKET, true, keccak256("c"), expiry + 1);
        vm.prank(alice); vm.expectRevert(); escrow.tip(bytes32(uint256(999)), 1, bytes32(uint256(1)));
        vm.prank(alice); vm.expectRevert(); escrow.tip(ID, 0, bytes32(uint256(1)));
        vm.prank(author); vm.expectRevert(); escrow.tip(ID, 1, bytes32(uint256(1)));
        vm.warp(expiry); vm.prank(alice); vm.expectRevert(); escrow.tip(ID, 1, bytes32(uint256(1)));
    }
    function testMainnetDeploymentRejected() public {
        vm.chainId(1); vm.expectRevert(); new TipEscrow(address(token), address(this), address(this));
    }
    function testNoRefundBeforeOutcomeOrTimeout() public {
        deposit(alice, 1e6, bytes32(uint256(1))); vm.expectRevert(); escrow.refund(ID, alice);
    }
    function testFuzzConservation(uint96 rawA, uint96 rawB, bool yesWon) public {
        uint256 a = uint256(rawA) % 5e6 + 1; uint256 b = uint256(rawB) % 5e6 + 1;
        deposit(alice, a, bytes32(uint256(1))); deposit(bob, b, bytes32(uint256(2)));
        require(token.balanceOf(address(escrow)) == a + b);
        vm.warp(expiry); escrow.reportOutcome(MARKET, yesWon);
        if (yesWon) { escrow.settle(ID); require(token.balanceOf(author) == a + b); }
        else { escrow.refund(ID, alice); escrow.refund(ID, bob); require(token.balanceOf(alice) == 20e6 && token.balanceOf(bob) == 20e6); }
        require(token.balanceOf(address(escrow)) == 0);
    }
}
