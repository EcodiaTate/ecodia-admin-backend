# EcodiaDAO Smart Contract

## Deployment

| Field | Value |
|-------|-------|
| Chain | Base Mainnet (chainId 8453) |
| Contract address | `0xE5B7F43d70dC5059c1C03BA8B27b3E6CcC3e2D54` |
| Deployed | 2026-04-08 |
| Admin wallet | `0x3B0D2c36Cda34E9a879Ed8C06e944C4d61643Bd` (Tate Donohoe) |
| Basescan | https://basescan.org/address/0xE5B7F43d70dC5059c1C03BA8B27b3E6CcC3e2D54 |

## What it is

On-chain public identifier for Ecodia DAO LLC (Wyoming DAO LLC, Entity ID 2026-001944432).  
Required under W.S. 17-31-105 and W.S. 17-31-106 for algorithmic DAOs.

The contract records:
- Entity metadata (name, Wyoming ID, formation date, jurisdiction) — immutable constants
- Membership structure: EcodiaOS 51% (algorithmic manager), Tate Donohoe 49%
- Operating agreement URI (mutable — update if the document moves)

## Reading the contract

All read functions are free (no gas):

```
daoInfo()           → name, wyomingId, formationDate, jurisdiction, publicIdentifier
membershipSummary() → manager name/bps, member name/bps, total bps
```

Or read constants directly: `DAO_NAME`, `WYOMING_ID`, `FORMATION_DATE`, etc.

## Admin functions (Tate only, costs gas)

```
updateOperatingAgreementURI(string)  → update if ecodia.au/dao/operating-agreement moves
updateHumanMemberWallet(address)     → update wallet address
transferAdmin(address)               → transfer admin role
```

Call these via Remix (Injected Provider → Base Mainnet → paste contract address under "At Address").

## Redeploying / modifying

The entity metadata constants are immutable once deployed. If they need to change, a new contract must be deployed and the Wyoming filing updated with the new address.

To redeploy: open `contracts/EcodiaDAO.sol` in Remix, compile with 0.8.20, deploy on Base with `_humanMemberWallet = 0x3B0D2c36Cda34E9a879Ed8C06e944C4d61643Bd`.
