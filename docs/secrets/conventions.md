---
triggers: creds-conventions, kv_store-conventions, secrets-conventions, naming-conventions-creds, misclassified, namespace-drift
class: programmatic-required
owner: ecodiaos
---

# creds.conventions

**Misclassified row.** Holds documentation about credential storage conventions (`always_store, migration_pattern, puppeteer_first, storage_pattern, verification`), not actual credentials. Lives under the `creds.*` prefix because that was a convenience at write time. The runtime impact of the misclassification is zero (no consumers).

## Source

Internal documentation row, populated 19 Apr 2026.

## Shape

object `{always_store, migration_pattern, puppeteer_first, storage_pattern, verification}`

## Used by

None. Historical reference; no live consumer.

## Replaceable by macro?

N/A - this is documentation, not a credential.

## Rotation

N/A.

## Restoration if lost

Don't restore. The content has been superseded by:

- `~/ecodiaos/docs/secrets/INDEX.md` (this directory's index - the canonical answer to "what creds exist")
- `~/ecodiaos/CLAUDE.md` "Credentials" section (5-row high-level table)
- `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md` (the doctrine that decides what creds to keep at all)

## Cleanup recommendation

This row should be migrated out of the `creds.*` namespace (proposed: `docs.conventions.creds` or simply deleted). NEEDS-FOLLOW-UP-FORK because changing kv_store key paths can break grep-based scripts in unexpected places, and the registry-shipping fork is forbidden from kv_store mutations.

After migration:
1. Confirm no grep matches in `~/ecodiaos/{scripts,src,patterns,clients,drafts}/` for the literal string `creds.conventions`.
2. Migrate or delete the row.
3. Remove this file.
