---
triggers: coexist, excel, excel-sync, sharepoint-file, drive_id, item_id, sheet_name, microsoft-graph-file, registration-spreadsheet, coexist-forms
class: programmatic-required
owner: ecodiaos
---

# creds.coexist_excel_file

Microsoft Graph metadata identifying the Co-Exist registration Excel file. NOT a credential per se - this is reference data (drive ID, item ID, sheet name, columns) that the excel-sync Edge Function uses to target the correct file. Stored under `creds.*` prefix as a convenience but classified as metadata.

## Source

Microsoft Graph API drives endpoint, captured during Co-Exist excel-sync setup. The `drive_id` is Co-Exist's SharePoint document library; the `item_id` is the specific Excel workbook.

## Shape

object `{drive_id, file_name, item_id, sheet_name, columns, row_count}`

## Used by

- The deployed Co-Exist Edge Function `excel-sync` (file targeting)
- `~/ecodiaos/clients/coexist.md` (excel-sync architecture)
- `~/ecodiaos/patterns/excel-sync-collectives-migration.md`

## Replaceable by macro?

N/A - this is metadata, not a credential.

## Rotation

Changes only if Co-Exist moves or renames the spreadsheet. Stable in the steady state.

## Restoration if lost

1. With `creds.coexist_graph_api` valid, query Graph API:
   ```
   GET https://graph.microsoft.com/v1.0/drives/<drive_id>/items?$filter=name eq '<file_name>'
   ```
2. Or browse via the Graph Explorer GUI to recover drive_id + item_id.
3. UPSERT `creds.coexist_excel_file` with refreshed metadata.

## Failure mode if missing

Excel-sync cannot locate the file; Edge Function errors with "404 itemNotFound" or similar.

## Drift / classification note

This row is technically misclassified under `creds.*`. It holds reference data, not secrets. Future migration could move it to a `meta.coexist.excel_file` namespace. Out of scope for the registry-shipping fork.
