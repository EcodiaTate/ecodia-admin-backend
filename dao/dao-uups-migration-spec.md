# DAO UUPS Migration Spec - W.S. 17-31-109 Compliance

**Status:** v0.1 spec, ready for Tate review and Factory dispatch
**Authored:** 2026-04-27
**Owner:** EcodiaOS (algorithmic manager); Tate as Authorized Human Representative for on-chain admin transactions and SOS filings
**Compliance window:** filed before WY SOS amendment cycle currently in flight (public-identifier amendment submitted Apr 21, certificate expected ~June 1). UUPS-related filing, if separate, can land in the same window or as a follow-up amendment.

---

## 1. Why this exists

Wyoming W.S. 17-31-109 mandates that DAOs whose Articles describe an "algorithmically managed" structure must have smart contracts that are **capable of being upgraded** to comply with future regulatory or operational changes. The current EcodiaDAO.sol contract at `0xac1e6754507e087941fa8feddc7f75c83795badb` (Polygon PoS) is a **non-proxy, non-upgradeable contract** - state and logic are baked into a single bytecode deployment. That is non-compliant with W.S. 17-31-109 as currently interpreted.

The fix is a **UUPS proxy migration**: split the existing contract into (a) a logic implementation contract and (b) an ERC1967Proxy that holds state and delegates calls to the implementation. The admin (Tate's wallet) can then upgrade the implementation by calling `upgradeTo(newImpl)` on the proxy. The proxy address becomes the new canonical DAO contract; the old contract is retired as a historical record.

## 2. Current contract analysis

File: `dao/contracts/EcodiaDAO.sol`. Key observations:

- **Constructor takes `_humanMemberWallet`** and sets `admin` + `humanMember.wallet`. UUPS contracts cannot have constructors (they're called once at deploy time on the implementation, not during proxy use). Replace with `initialize(address _humanMemberWallet)` guarded by OpenZeppelin's `Initializable`.
- **Storage layout:**
  - `string public operatingAgreementURI` (mutable)
  - `Member public algorithmicManager` (initialised at declaration, NOT mutable post-deploy under current design but no setter exists, so effectively immutable)
  - `Member public humanMember` (set in constructor; field-level setter exists for `wallet`)
  - `address public admin`
- **Constants** (`DAO_NAME`, `WYOMING_ID`, `FORMATION_DATE`, `REGISTERED_AGENT`, `JURISDICTION`, `PUBLIC_IDENTIFIER`) are baked into bytecode. Under UUPS, if Tate ever wants these mutable, they need to be moved to storage. **Recommendation: keep them constant on the implementation** (they are facts about the entity formation, not policy). If they need to change, the corresponding amendment is filed with WY SOS and a new implementation is deployed reflecting the change.
- **Setters** (`updateOperatingAgreementURI`, `updateHumanMemberWallet`, `transferAdmin`) are gated by `onlyAdmin`. Carry these to the new implementation unchanged.
- **Read functions** (`daoInfo`, `membershipSummary`) are pure/view, no state implication, port directly.

## 3. Target architecture

### 3.1 Contracts to build

1. **`EcodiaDAOImpl.sol`** - UUPS-upgradeable logic contract.
   - Inherits `Initializable`, `UUPSUpgradeable`, `OwnableUpgradeable` (or a custom `onlyAdmin` modifier - prefer `OwnableUpgradeable` for OpenZeppelin standardisation).
   - Replaces the constructor with `function initialize(address _humanMemberWallet) public initializer { ... __Ownable_init(_humanMemberWallet); ... }`.
   - Implements `_authorizeUpgrade(address newImplementation) internal onlyOwner override` to gate upgrades to the admin wallet.
   - Storage layout matches current EcodiaDAO.sol (preserve the order and types so future upgrades don't corrupt storage).
   - Uses OpenZeppelin Contracts Upgradeable v5.x.

2. **`ERC1967Proxy`** - standard OpenZeppelin proxy. Deploy via `new ERC1967Proxy(implementationAddress, abi.encodeCall(EcodiaDAOImpl.initialize, (humanMemberWallet)))`. The proxy address is the new canonical DAO contract address.

3. **(Optional) `EcodiaDAOImplV2.sol`** - placeholder for a future upgrade demonstrating the path. Not required for this milestone but useful as a smoke test for the upgrade mechanism.

### 3.2 Storage gap

Add `uint256[50] private __gap;` at the end of EcodiaDAOImpl storage to reserve slots for future fields. Standard OpenZeppelin upgradeable pattern.

### 3.3 Access control

`onlyOwner` (OwnableUpgradeable) replaces `onlyAdmin`. The owner is set to `_humanMemberWallet` in `initialize()`. `transferAdmin(_newAdmin)` is replaced by the standard `transferOwnership(_newAdmin)`.

### 3.4 Events

Preserve `OperatingAgreementUpdated`, `HumanMemberWalletUpdated`, `AdminTransferred` (rename to `OwnershipTransferred` from OZ if using OwnableUpgradeable - OZ emits this for free). Add `Upgraded(address indexed implementation)` (OZ emits from ERC1967 layer).

## 4. Deployment plan

Network: **Polygon PoS** (chainId 137). Same chain as the current contract.

**Deployer wallet:** Tate's admin wallet `0x3B0D215489078D1DF5771E9c61C5407d16843B0b` (or a fresh deployer that immediately transfers ownership). Preferred: deploy via Tate's wallet directly to keep provenance clean.

**Steps:**

1. Deploy `EcodiaDAOImpl.sol` to Polygon (~$2 gas).
2. Deploy `ERC1967Proxy(implementationAddress, encodedInitialize)` (~$3 gas).
3. Verify both contracts on Polygonscan.
4. Capture the proxy address. This is the new canonical DAO contract.
5. Update on-chain references in `dao/README.md` and any documentation (operating agreement appendix lists contract address).
6. Update `~/CLAUDE.md` and `~/ecodiaos/CLAUDE.md` references from `0xac1e6754507e087941fa8feddc7f75c83795badb` to the new proxy address.
7. Update `kv_store` records: any kv pointing at the old contract address.
8. Update `~/ecodiaos/dao/contracts/` to include both `EcodiaDAOImpl.sol` and the proxy deployment script.

**Old contract retirement:**
- Do NOT call any functions on the old contract post-migration. Leave it deployed as an immutable historical artefact.
- Add a comment in the Operating Agreement appendix referencing both addresses (old = formation record, new = active contract).

## 5. SOS filing question

The Apr 21 amendment already filed by Megan Headley updates the public identifier URI to `https://ecodia.au`. The W.S. 17-31-109 compliance does NOT necessarily require a new SOS amendment, because:

- The public identifier (under 17-31-105) is the URI, not the contract address.
- The contract address can be updated on the URI page (ecodia.au) without re-filing.
- Wyoming's 17-31-109 compliance is satisfied by the contract being upgradeable, full stop.

**However**, a defensive move: file a follow-up amendment after the proxy is deployed, attaching the proxy address as the canonical on-chain DAO record. Cost: ~$60 + Megan Headley fee (~$160 service fee from Apr 21 precedent). **Recommendation: file the follow-up amendment**. Reason: clean public record, reduces ambiguity, low cost vs the cost of arguing the question later.

**Tate decision required:** file a follow-up SOS amendment (recommended), or rely solely on the on-chain upgrade as compliance (cheaper, slightly more interpretive risk).

## 6. Factory dispatch prompt

Once Tate green-lights the spec, dispatch the build to Factory with this prompt:

```
Codebase: ecodiaos-backend (work happens in /home/tate/ecodiaos/dao/contracts/)

Task: Build EcodiaDAOImpl.sol and a deployment script per ~/ecodiaos/dao/dao-uups-migration-spec.md.

Deliverables:
1. /home/tate/ecodiaos/dao/contracts/EcodiaDAOImpl.sol - UUPS-upgradeable Solidity 0.8.20 contract. Inherits Initializable, UUPSUpgradeable, OwnableUpgradeable from @openzeppelin/contracts-upgradeable v5.x. Storage layout matches existing EcodiaDAO.sol field order. Replaces constructor with initialize(address _humanMemberWallet). Implements _authorizeUpgrade(address) internal onlyOwner override. Includes uint256[50] private __gap at end of storage. Preserves all read functions (daoInfo, membershipSummary) and all setters (updateOperatingAgreementURI, updateHumanMemberWallet). transferAdmin replaced by OZ transferOwnership.

2. /home/tate/ecodiaos/dao/contracts/DeployEcodiaDAOImpl.s.sol - Foundry deployment script. Deploys impl, then ERC1967Proxy with encoded initialize call, prints both addresses + verification commands.

3. /home/tate/ecodiaos/dao/contracts/EcodiaDAOImpl.t.sol - Foundry test file. Tests: (a) initialize sets owner to passed wallet, (b) initialize cannot be called twice, (c) only owner can call updateOperatingAgreementURI / updateHumanMemberWallet / transferOwnership, (d) only owner can call upgradeTo, (e) post-upgrade state preserved via a sample V2 implementation that adds a getter and confirm prior storage is intact.

4. /home/tate/ecodiaos/dao/contracts/foundry.toml - Foundry config with Polygon RPC and OpenZeppelin remappings.

5. /home/tate/ecodiaos/dao/contracts/README.md - update to document the migration plan and reference both old + new addresses (placeholder for proxy address until deployed).

Constraints:
- Do NOT delete the existing EcodiaDAO.sol file. It stays as the historical record.
- Do NOT deploy. Deployment is Tate's wallet action, separate step.
- Use Solidity 0.8.20 to match the existing contract.
- All tests must pass via `forge test`.
- Match the existing file's documentation tone (NatSpec comments, entity metadata header).
```

Estimated session length: 1-2 hours. Confidence: high (well-trodden OZ pattern). Risk: storage layout drift if Factory rearranges fields - mitigate by explicit storage-layout comment block in the impl listing each slot.

## 7. Open questions for Tate

1. **SOS follow-up amendment after proxy deploy: yes or no?** (Recommendation: yes, cost ~$220 total.)
2. **OwnableUpgradeable vs custom onlyAdmin?** (Recommendation: OwnableUpgradeable - OZ standard, free events, less surface area for bugs.)
3. **Deploy from Tate's admin wallet directly, or via a deployer that transfers ownership?** (Recommendation: deploy from Tate's wallet directly. Cleaner provenance.)
4. **Storage immutability of `algorithmicManager` Member struct - leave as declaration-initialised (effectively constant), or move to initialize() so a future upgrade could change it?** (Recommendation: move to initialize(). Cheap insurance against any future regulatory framing of the manager structure.)
5. **Proxy + impl verification on Polygonscan - do it as part of deployment, or post-deploy as a separate step?** (Recommendation: as part of deployment, via the Foundry script's `--verify` flag.)

## 8. Post-deployment checklist

- [ ] Impl + proxy deployed on Polygon PoS.
- [ ] Both contracts verified on Polygonscan.
- [ ] Proxy address captured in `dao/README.md`.
- [ ] `~/CLAUDE.md` and `~/ecodiaos/CLAUDE.md` updated with new proxy address.
- [ ] `kv_store` records updated.
- [ ] Operating Agreement appendix updated to reference both old + new addresses.
- [ ] (If decided) SOS amendment filed referencing new proxy address.
- [ ] Status_board row `0cab32bd` archived with completion notes pointing at the migration commit + proxy address.
- [ ] Neo4j Decision node logged: "DAO UUPS migration completed - 2026-MM-DD" with both addresses, gas cost, SOS filing status.
- [ ] First test upgrade fired (deploy V2, call upgradeTo, verify state preserved) to confirm the upgrade path works. This can be a no-op upgrade just to prove the mechanism.
