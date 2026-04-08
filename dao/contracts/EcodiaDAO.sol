// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title EcodiaDAO
 * @notice Governance contract for Ecodia DAO LLC
 * @dev Wyoming DAO LLC — Entity ID: 2026-001944432
 *      Public identifier pursuant to W.S. 17-31-105 and W.S. 17-31-106
 *
 *      This contract serves as the publicly available identifier of the DAO
 *      and records membership interests and management structure.
 *
 *      Deployed on Polygon for low cost and permanence.
 */
contract EcodiaDAO {

    // -------------------------------------------------------------------------
    // Entity metadata (immutable, on-chain public record)
    // -------------------------------------------------------------------------

    string public constant DAO_NAME           = "Ecodia DAO LLC";
    string public constant WYOMING_ID         = "2026-001944432";
    string public constant FORMATION_DATE     = "2026-04-08";
    string public constant REGISTERED_AGENT   = "Registered Agents Inc, Sheridan WY";
    string public constant JURISDICTION       = "Wyoming, United States";

    /// @notice URI to the publicly available operating agreement
    string public operatingAgreementURI = "https://ecodia.au/dao/operating-agreement";

    /// @notice Public-facing identifier (the DAO's web presence)
    string public constant PUBLIC_IDENTIFIER  = "https://ecodia.au";

    // -------------------------------------------------------------------------
    // Membership structure (basis points — 10000 = 100%)
    // -------------------------------------------------------------------------

    struct Member {
        string  name;
        uint256 interestBps; // basis points
        address wallet;
        bool    isAlgorithmicManager;
    }

    Member public algorithmicManager = Member({
        name:                 "EcodiaOS",
        interestBps:          5100,         // 51%
        wallet:               address(0),   // AI system — no wallet
        isAlgorithmicManager: true
    });

    Member public humanMember;

    // -------------------------------------------------------------------------
    // Admin controls (human member can update addresses and URIs)
    // -------------------------------------------------------------------------

    address public admin;

    event OperatingAgreementUpdated(string newURI);
    event HumanMemberWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "EcodiaDAO: not authorised");
        _;
    }

    /**
     * @param _humanMemberWallet  Wallet address of the human member (Tate Donohoe)
     */
    constructor(address _humanMemberWallet) {
        admin = _humanMemberWallet;

        humanMember = Member({
            name:                 "Tate Donohoe",
            interestBps:          4900,         // 49%
            wallet:               _humanMemberWallet,
            isAlgorithmicManager: false
        });
    }

    // -------------------------------------------------------------------------
    // Read functions
    // -------------------------------------------------------------------------

    /// @notice Returns high-level DAO info for the Wyoming public identifier requirement
    function daoInfo() external pure returns (
        string memory name,
        string memory wyomingId,
        string memory formationDate,
        string memory jurisdiction,
        string memory publicIdentifier
    ) {
        return (
            DAO_NAME,
            WYOMING_ID,
            FORMATION_DATE,
            JURISDICTION,
            PUBLIC_IDENTIFIER
        );
    }

    /// @notice Returns membership summary (names + basis points)
    function membershipSummary() external view returns (
        string memory managerName,
        uint256        managerInterestBps,
        string memory memberName,
        uint256        memberInterestBps,
        uint256        totalBps
    ) {
        return (
            algorithmicManager.name,
            algorithmicManager.interestBps,
            humanMember.name,
            humanMember.interestBps,
            algorithmicManager.interestBps + humanMember.interestBps
        );
    }

    // -------------------------------------------------------------------------
    // Admin functions (upgradeable per Wyoming requirement for algorithmic DAOs)
    // -------------------------------------------------------------------------

    /// @notice Update the operating agreement URI (e.g. if the document moves)
    function updateOperatingAgreementURI(string calldata _newURI) external onlyAdmin {
        operatingAgreementURI = _newURI;
        emit OperatingAgreementUpdated(_newURI);
    }

    /// @notice Update the human member's wallet address
    function updateHumanMemberWallet(address _newWallet) external onlyAdmin {
        emit HumanMemberWalletUpdated(humanMember.wallet, _newWallet);
        humanMember.wallet = _newWallet;
    }

    /// @notice Transfer admin role to a new address
    function transferAdmin(address _newAdmin) external onlyAdmin {
        require(_newAdmin != address(0), "EcodiaDAO: zero address");
        emit AdminTransferred(admin, _newAdmin);
        admin = _newAdmin;
    }
}
