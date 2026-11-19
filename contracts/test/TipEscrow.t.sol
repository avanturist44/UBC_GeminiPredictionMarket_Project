// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {TipEscrow} from "../src/TipEscrow.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract TipEscrowTest is Test {
    MockUSDC usdc;
    TipEscrow esc;
    address registrar = address(0xA1);
    address resolver = address(0xA2);
    address author = address(0xB1);
    address alice = address(0xC1);
    address bob = address(0xC2);
    bytes32 id = keccak256("t1");
    bytes32 mkt = keccak256("GEMI-X-UP");
    uint64 expiry;

    function setUp() public {
        usdc = new MockUSDC();
        esc = new TipEscrow(address(usdc), registrar, resolver);
        expiry = uint64(block.timestamp + 900);
        for (uint256 i; i < 2; i++) {
            address u = i == 0 ? alice : bob;
            usdc.mint(u, 100e6);
            vm.prank(u);
            usdc.approve(address(esc), type(uint256).max);
        }
        vm.prank(registrar);
        esc.registerThesis(id, author, mkt, true, bytes32("h"), expiry);
    }

    function _tips() internal {
        vm.prank(alice);
        esc.tip(id, 1e6);
        vm.prank(bob);
        esc.tip(id, 250000);
    }

    function test_rightPaysAuthor() public {
        _tips();
        vm.prank(resolver);
        esc.reportOutcome(mkt, true);
        esc.settle(id);
        assertEq(usdc.balanceOf(author), 1250000);
        assertEq(usdc.balanceOf(address(esc)), 0);
        vm.expectRevert(bytes("settled"));
        esc.settle(id);
        vm.expectRevert(bytes("not refundable"));
        esc.refund(id, alice);
    }

    function test_wrongRefunds() public {
        _tips();
        vm.prank(resolver);
        esc.reportOutcome(mkt, false);
        vm.expectRevert(bytes("author wrong"));
        esc.settle(id);
        esc.refund(id, alice);
        esc.refund(id, bob);
        assertEq(usdc.balanceOf(alice), 100e6);
        assertEq(usdc.balanceOf(bob), 100e6);
        assertEq(usdc.balanceOf(address(esc)), 0);
        vm.expectRevert(bytes("nothing to refund"));
        esc.refund(id, alice);
    }

    function test_void() public {
        _tips();
        vm.prank(resolver);
        esc.reportVoid(mkt);
        vm.expectRevert(bytes("no outcome"));
        esc.settle(id);
        esc.refund(id, alice);
        assertEq(usdc.balanceOf(alice), 100e6);
    }

    function test_timeoutThenLateReport() public {
        _tips();
        vm.expectRevert(bytes("not refundable"));
        esc.refund(id, alice);
        vm.warp(uint256(expiry) + 7 days + 1);
        esc.refund(id, alice);
        assertEq(usdc.balanceOf(alice), 100e6);
        vm.prank(resolver);
        esc.reportOutcome(mkt, true);
        esc.settle(id);
        assertEq(usdc.balanceOf(author), 250000);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }

    function test_access() public {
        vm.expectRevert(bytes("not registrar"));
        esc.registerThesis(keccak256("t2"), author, mkt, true, bytes32("h"), expiry);
        vm.expectRevert(bytes("not resolver"));
        esc.reportOutcome(mkt, true);
        vm.expectRevert(bytes("not resolver"));
        esc.reportVoid(mkt);
        vm.startPrank(resolver);
        esc.reportOutcome(mkt, true);
        vm.expectRevert(bytes("already reported"));
        esc.reportOutcome(mkt, false);
        vm.expectRevert(bytes("already reported"));
        esc.reportVoid(mkt);
        vm.stopPrank();
    }

    function test_guards() public {
        vm.startPrank(alice);
        vm.expectRevert(bytes("unknown thesis"));
        esc.tip(keccak256("nope"), 1e6);
        vm.expectRevert(bytes("bad amount"));
        esc.tip(id, 0);
        vm.expectRevert(bytes("bad amount"));
        esc.tip(id, 5e6 + 1);
        esc.tip(id, 5e6);
        vm.expectRevert(bytes("bad amount"));
        esc.tip(id, 1);
        vm.stopPrank();
        vm.prank(registrar);
        vm.expectRevert(bytes("exists"));
        esc.registerThesis(id, author, mkt, true, bytes32("h"), expiry);
        vm.warp(expiry);
        vm.prank(bob);
        vm.expectRevert(bytes("expired"));
        esc.tip(id, 1e6);
    }

    function test_noTipAfterReport() public {
        vm.prank(resolver);
        esc.reportOutcome(mkt, true);
        vm.prank(alice);
        vm.expectRevert(bytes("market closed"));
        esc.tip(id, 1e6);
        vm.prank(registrar);
        vm.expectRevert(bytes("market closed"));
        esc.registerThesis(keccak256("t3"), author, mkt, true, bytes32("h"), expiry);
    }

    function testFuzz_balanceMatches(uint256 a, uint256 b, bool yesWon, bool refundAliceFirst) public {
        a = bound(a, 1, 5e6);
        b = bound(b, 1, 5e6);
        vm.prank(alice);
        esc.tip(id, a);
        vm.prank(bob);
        esc.tip(id, b);
        assertEq(usdc.balanceOf(address(esc)), a + b);
        vm.prank(resolver);
        esc.reportOutcome(mkt, yesWon);
        if (yesWon) {
            esc.settle(id);
            assertEq(usdc.balanceOf(author), a + b);
        } else {
            if (refundAliceFirst) {
                esc.refund(id, alice);
                assertEq(usdc.balanceOf(address(esc)), b);
                esc.refund(id, bob);
            } else {
                esc.refund(id, bob);
                esc.refund(id, alice);
            }
            assertEq(usdc.balanceOf(author), 0);
        }
        assertEq(usdc.balanceOf(address(esc)), 0);
    }
}
