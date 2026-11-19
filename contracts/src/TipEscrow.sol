// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Testnet-only outcome-contingent tips. No admin withdrawal, fees, upgrades or arbitrary payouts.
contract TipEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum MarketState { Open, YesWon, NoWon, Void }
    struct Thesis {
        address author;
        bytes32 marketId;
        bytes32 contentHash;
        uint64 expiry;
        bool sideYes;
        bool settled;
        uint128 totalTips;
    }
    uint256 public constant MAX_TIP = 5e6;
    uint64 public constant TIMEOUT = 7 days;
    IERC20 public immutable usdc;
    address public immutable registrar;
    address public immutable resolver;
    mapping(bytes32 => Thesis) public theses;
    mapping(bytes32 => MarketState) public marketState;
    mapping(bytes32 => uint64) public marketExpiry;
    mapping(bytes32 => mapping(address => uint256)) public tipOf;
    mapping(bytes32 => bool) public usedTipRequest;
    event ThesisRegistered(bytes32 indexed id, address indexed author, bytes32 indexed marketId, bool sideYes, bytes32 contentHash, uint64 expiry);
    event Tipped(bytes32 indexed id, address indexed tipper, uint256 amount, bytes32 indexed requestId);
    event OutcomeReported(bytes32 indexed marketId, MarketState state);
    event AuthorPaid(bytes32 indexed id, address indexed author, uint256 amount);
    event Refunded(bytes32 indexed id, address indexed tipper, uint256 amount);

    constructor(address token, address registrar_, address resolver_) {
        require(block.chainid == 5042002 || block.chainid == 31337, "testnet only");
        require(token != address(0) && registrar_ != address(0) && resolver_ != address(0), "zero address");
        require(IERC20Metadata(token).decimals() == 6, "USDC decimals");
        usdc = IERC20(token); registrar = registrar_; resolver = resolver_;
    }
    function registerThesis(bytes32 id, address author, bytes32 marketId, bool sideYes, bytes32 contentHash, uint64 expiry) external {
        require(msg.sender == registrar, "not registrar");
        require(id != bytes32(0) && marketId != bytes32(0) && contentHash != bytes32(0), "empty identifier");
        require(author != address(0) && theses[id].author == address(0), "invalid author or exists");
        require(marketState[marketId] == MarketState.Open && expiry > block.timestamp, "market closed");
        require(marketExpiry[marketId] == 0 || marketExpiry[marketId] == expiry, "expiry mismatch");
        marketExpiry[marketId] = expiry;
        theses[id] = Thesis(author, marketId, contentHash, expiry, sideYes, false, 0);
        emit ThesisRegistered(id, author, marketId, sideYes, contentHash, expiry);
    }
    function tip(bytes32 id, uint256 amount, bytes32 requestId) external nonReentrant {
        Thesis storage t = theses[id];
        require(t.author != address(0) && msg.sender != t.author, "unknown thesis or self tip");
        require(block.timestamp < t.expiry && marketState[t.marketId] == MarketState.Open, "market closed");
        require(requestId != bytes32(0), "empty request");
        bytes32 request = keccak256(abi.encode(msg.sender, requestId));
        require(!usedTipRequest[request], "duplicate request");
        require(amount > 0 && tipOf[id][msg.sender] + amount <= MAX_TIP, "bad amount");
        usedTipRequest[request] = true;
        tipOf[id][msg.sender] += amount;
        t.totalTips += uint128(amount);
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        require(usdc.balanceOf(address(this)) - beforeBalance == amount, "transfer mismatch");
        emit Tipped(id, msg.sender, amount, requestId);
    }
    function reportOutcome(bytes32 marketId, bool yesWon) external {
        _report(marketId, yesWon ? MarketState.YesWon : MarketState.NoWon);
    }
    function reportVoid(bytes32 marketId) external { _report(marketId, MarketState.Void); }
    function _report(bytes32 marketId, MarketState state) private {
        require(msg.sender == resolver, "not resolver");
        require(marketExpiry[marketId] != 0 && block.timestamp >= marketExpiry[marketId], "not expired");
        require(marketState[marketId] == MarketState.Open, "already reported");
        marketState[marketId] = state;
        emit OutcomeReported(marketId, state);
    }
    function settle(bytes32 id) external nonReentrant {
        Thesis storage t = theses[id];
        require(t.author != address(0) && !t.settled, "unknown or settled");
        MarketState s = marketState[t.marketId];
        require(s == MarketState.YesWon || s == MarketState.NoWon, "no outcome");
        require((s == MarketState.YesWon) == t.sideYes, "author wrong");
        t.settled = true;
        uint256 amount = t.totalTips;
        t.totalTips = 0;
        if (amount != 0) usdc.safeTransfer(t.author, amount);
        emit AuthorPaid(id, t.author, amount);
    }
    function refund(bytes32 id, address tipper) external nonReentrant {
        Thesis storage t = theses[id];
        require(t.author != address(0), "unknown thesis");
        MarketState s = marketState[t.marketId];
        bool wrong = (s == MarketState.YesWon && !t.sideYes) || (s == MarketState.NoWon && t.sideYes);
        bool timedOut = s == MarketState.Open && block.timestamp > uint256(t.expiry) + TIMEOUT;
        require(wrong || s == MarketState.Void || timedOut, "not refundable");
        uint256 amount = tipOf[id][tipper];
        require(amount != 0, "nothing to refund");
        tipOf[id][tipper] = 0;
        t.totalTips -= uint128(amount);
        usdc.safeTransfer(tipper, amount);
        emit Refunded(id, tipper, amount);
    }
}
