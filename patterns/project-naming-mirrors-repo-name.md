---
triggers: vercel-project-name, vercel-cli-link, vercel-link-cli, vercel-project-create, project-naming, project-naming-mirrors-repo, fe-project-name, be-project-name, vercel-naming-convention, projectName, vercel-scaffold-naming, PROJECT_NAMING
---

# Vercel projects (and any cloud project name) mirror the GitHub repo name. Never `fe`, never `be`, never the directory's relative name.

## TOP-LINE INVARIANT

**The Vercel project name MUST equal the GitHub repo name.** GitHub repo `chambers-frontend` -> Vercel project `chambers-frontend`. GitHub repo `ordit-backend` -> Vercel project `ordit-backend`. Never the relative directory name (`fe`, `be`, `frontend`, `app`). Never the working-copy convention. The cross-system identifier is the repo name.

## Why this matters

A Vercel project named `fe` is unidentifiable in `vercel_list_projects`. It collides with every other frontend in the org. The deploy URL becomes `fe-4mmnc0utj-ecodia.vercel.app` - useless to read, useless to share, useless to debug. When I list projects later I have no idea which `fe` belongs to which client. The internal directory convention `~/workspaces/{slug}/fe` is a LOCAL filesystem layout - it does NOT propagate to Vercel as the project name.

## The failure source

Forks running `vercel link` or `vercel deploy` from inside `~/workspaces/{slug}/fe` will prompt for a project name and default to the parent directory's name (`fe`). If the fork blindly accepts the default (or the CLI auto-creates), the Vercel project is named `fe`. This has now happened on chambers (`fe-4mmnc0utj-ecodia.vercel.app`) and at least one other historical project (`celt-...` for `campouts-coexist`).

## The mechanical fix - mandatory in every deploy-touching brief

```
PROJECT NAMING (non-negotiable):
- The Vercel project name MUST be the GitHub repo name.
- Run `vercel link --project=<repo-name>` explicitly. Do NOT accept the directory-name default.
- Before deploying, verify .vercel/project.json has projectName == <repo-name>.
- If you find a misnamed project (e.g. `fe`, `be`, `frontend`), rename it via PATCH /v9/projects/{id}/rename and update .vercel/project.json.
```

This goes in EVERY brief that creates or touches a Vercel project, in the deploy-verify section.

## Do
- Pass `--project=<repo-name>` to `vercel link` explicitly.
- Verify `.vercel/project.json` `projectName` field matches the repo name before pushing.
- Rename misnamed Vercel projects via the API: `PATCH /v9/projects/{id}/rename?teamId=...` with body `{"name":"<repo-name>"}`.
- Apply the same rule to GitHub repos created from forks: `<slug>-frontend` / `<slug>-backend`, never just `fe`/`be`.

## Do NOT
- Accept the `vercel link` directory-default for project name.
- Use working-copy directory conventions (`fe`, `be`) as cross-system identifiers.
- Leave a misnamed Vercel project in place "to avoid breaking the deploy" - the deploy URL changes anyway when the project renames, and the rename is a 200-OK API call.

## Verification (conductor-side)

When reviewing a fork that created or touched a Vercel project:
1. `mcp__business-tools__vercel_list_projects` - look for any project named `fe`, `be`, `frontend`, `backend`, or anything that doesn't match a known repo.
2. If found, rename via API + delete orphan duplicates + update local `.vercel/project.json`.
3. Confirm the GitHub link in the project metadata matches the expected repo.

## Origin

2026-04-28 12:50 AEST. The chambers app fork created a Vercel project named `fe` (id `prj_mVSfTtjHT6cn3gXAoVfhNvjvpc4x`) by accepting the `vercel link` default from inside `~/workspaces/chambers/fe`. There was also a separate orphan `chambers-frontend` project with no deployments. Tate flagged: "you named the vercel project for the chambers fe literally just 'fe' wtf... probably same thing with the github repo." (GitHub repo was correctly `chambers-frontend`; only Vercel was misnamed.) Renamed `fe` -> `chambers-frontend` via PATCH, deleted the orphan, updated `.vercel/project.json`. Doctrine codified to prevent recurrence.

## Related

- `deploy-verify-or-the-fork-didnt-finish.md` (companion failure from same fork)
- `brief-names-the-product-not-the-immediate-task.md` (brief skeleton enforcement layer)
