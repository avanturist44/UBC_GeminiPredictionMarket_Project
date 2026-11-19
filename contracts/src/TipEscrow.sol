// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract TipEscrow {
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

    uint256 public constant MAX_TIP = 5e6; // 5 USDC at 6 decimals
    uint64 public constant TIMEOUT = 7 days;

    IERC20 public immutable usdc;
    address public immutable registrar;
    address public immutable resolver;

    mapping(bytes32 => Thesis) public theses;
    mapping(bytes32 => MarketState) public marketState;
    mapping(bytes32 => mapping(address => uint256)) public tipOf;

    event ThesisRegistered(bytes32 indexed id, address indexed author, bytes32 indexed marketId, bool sideYes, bytes32 contentHash, uint64 expiry);
    event Tipped(bytes32 indexed id, address indexed tipper, uint256 amount);
    event OutcomeReported(bytes32 indexed marketId, MarketState state);
    event AuthorPaid(bytes32 indexed id, address indexed author, uint256 amount);
    event Refunded(bytes32 indexed id, address indexed tipper, uint256 amount);

    constructor(address usdc_, address registrar_, address resolver_) {
        require(usdc_ != address(0) && registrar_ != address(0) && resolver_ != address(0), "zero address");
        usdc = IERC20(usdc_);
        registrar = registrar_;
        resolver = resolver_;
    }

    function registerThesis(bytes32 id, address author, bytes32 marketId, bool sideYes, bytes32 contentHash, uint64 expiry) external {
        require(msg.sender == registrar, "not registrar");
        require(author != address(0), "no author");
        require(theses[id].author == address(0), "exists");
        require(marketState[marketId] == MarketState.Open, "market closed");
        require(expiry > block.timestamp, "expired");
        theses[id] = Thesis(author, marketId, contentHash, expiry, sideYes, false, 0);
        emit ThesisRegistered(id, author, marketId, sideYes, contentHash, expiry);
    }

    function tip(bytes32 id, uint256 amount) external {
        Thesis storage t = theses[id];
        require(t.author != address(0), "unknown thesis");
        require(block.timestamp < t.expiry, "expired");
        require(marketState[t.marketId] == MarketState.Open, "market closed");
        require(amount > 0 && tipOf[id][msg.sender] + amount <= MAX_TIP, "bad amount");
        tipOf[id][msg.sender] += amount;
        t.totalTips += uint128(amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Tipped(id, msg.sender, amount);
    }

    function reportOutcome(bytes32 marketId, bool yesWon) external {
        require(msg.sender == resolver, "not resolver");
        require(marketState[marketId] == MarketState.Open, "already reported");
        marketState[marketId] = yesWon ? MarketState.YesWon : MarketState.NoWon;
        emit OutcomeReported(marketId, marketState[marketId]);
    }

    function reportVoid(bytes32 marketId) external {
        require(msg.sender == resolver, "not resolver");
        require(marketState[marketId] == MarketState.Open, "already reported");
        marketState[marketId] = MarketState.Void;
        emit OutcomeReported(marketId, MarketState.Void);
    }

    // Pays the author when the thesis side matches the reported outcome.
    function settle(bytes32 id) external {
        Thesis storage t = theses[id];
        require(t.author != address(0), "unknown thesis");
        require(!t.settled, "settled");
        MarketState s = marketState[t.marketId];
        require(s == MarketState.YesWon || s == MarketState.NoWon, "no outcome");
        require((s == MarketState.YesWon) == t.sideYes, "author wrong");
        t.settled = true;
        uint256 amount = t.totalTips;
        t.totalTips = 0;
        if (amount > 0) usdc.safeTransfer(t.author, amount);
        emit AuthorPaid(id, t.author, amount);
    }

    // Returns one tipper's tip when the author was wrong, the market is void,
    // or no outcome was reported within TIMEOUT of expiry.
    function refund(bytes32 id, address tipper) external {
        Thesis storage t = theses[id];
        require(t.author != address(0), "unknown thesis");
        MarketState s = marketState[t.marketId];
        bool wrong = (s == MarketState.YesWon && !t.sideYes) || (s == MarketState.NoWon && t.sideYes);
        bool timedOut = s == MarketState.Open && block.timestamp > uint256(t.expiry) + TIMEOUT;
        require(wrong || s == MarketState.Void || timedOut, "not refundable");
        uint256 amount = tipOf[id][tipper];
        require(amount > 0, "nothing to refund");
        tipOf[id][tipper] = 0;
        t.totalTips -= uint128(amount);
        usdc.safeTransfer(tipper, amount);
        emit Refunded(id, tipper, amount);
    }
}
