# Ordit semgrep rulepack

Semgrep rules derived from Ordit (`fireauditors1/be`) PR reviews. Run before pushing any branch to
`ordit-backend`. See `clients/ordit/HOUSE_STYLE.md` for full context.

## Usage

Run the full pack:

```bash
semgrep --config .semgrep/ordit/ruleset.yml <path>
# e.g. semgrep --config .semgrep/ordit/ruleset.yml src/
```

Run a single rule:

```bash
semgrep --config .semgrep/ordit/no-as-any-cast.yml src/
```

Run all rules in the directory (duplicates rules from ruleset.yml - minor noise, still useful):

```bash
semgrep --config .semgrep/ordit/ src/
```

## Rules

| File | Severity | What it catches |
|---|---|---|
| `no-string-enum-comparison.yml` | ERROR | String literals used where Prisma AuthSource enum exists |
| `no-as-any-cast.yml` | ERROR | `as any` casts in TypeScript |
| `no-as-unknown-double-cast.yml` | ERROR | `as unknown as X` double casts |
| `no-promise-any-return.yml` | WARNING | `Promise<any>` as a return type annotation |
| `no-client-auth-source-dto.yml` | ERROR | DTO fields that should be server-decided (`authSource`, `useCognito`) |
| `no-db-push-in-pipelines.yml` | INFO | `prisma db push` in pipeline YAML - platform posture reminder |
| `no-dead-dto-fields-in-tests.yml` | WARNING | Dead DTO fields sent in test request bodies |
| `no-new-console-log.yml` | WARNING | New `console.log` calls |

## Origin

Every rule here corresponds to a real rejection or near-miss in PR 212 (Apr 2026). Eugene flags
these patterns consistently. Catching them mechanically before push saves review cycles.
