const logger = require('../config/logger')

// Expected enum values from application code (factoryOversightService.js, etc.)
const EXPECTED_ENUMS = {
  pipeline_stage: ['queued', 'context', 'executing', 'testing', 'deploying', 'complete', 'failed', 'awaiting_review'],
  deploy_status: [null, 'pending', 'deploying', 'deployed', 'failed', 'reverted', 'rejected'],
  status: ['initializing', 'running', 'completing', 'awaiting_input', 'complete', 'error', 'queued', 'paused', 'stopped'],
}

/**
 * Queries pg_constraint CHECK constraints for cc_sessions and compares
 * allowed values against hardcoded expected values from application code.
 * Non-fatal, advisory only — logs warnings for mismatches.
 */
async function validateSchemaConstraints(db) {
  try {
    // Get CHECK constraints for cc_sessions from pg_catalog
    const constraints = await db`
      SELECT conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE t.relname = 'cc_sessions'
        AND n.nspname = 'public'
        AND c.contype = 'c'
    `

    if (constraints.length === 0) {
      logger.warn('[schema-validator] No CHECK constraints found on cc_sessions — cannot validate enums')
      return
    }

    for (const { conname, def } of constraints) {
      // Match column name from constraint definition
      // Patterns: ((column = ANY (...))) or ((column)::text = ANY (...))
      const colMatch = def.match(/\(\((\w+)\)/)
      if (!colMatch) continue

      const column = colMatch[1]
      const expected = EXPECTED_ENUMS[column]
      if (!expected) continue

      // Extract allowed values from the constraint definition
      // Format: CHECK ((col = ANY (ARRAY['val1'::text, 'val2'::text, ...])))
      const valuesMatch = def.match(/ARRAY\[([^\]]+)\]/)
      if (!valuesMatch) continue

      const dbValues = valuesMatch[1]
        .split(',')
        .map(v => v.trim().replace(/^'|'(::[\w\s]+)?$/g, ''))
        .filter(Boolean)

      // Compare: find values in code that aren't in DB constraint
      const nonNullExpected = expected.filter(v => v !== null)
      const missingFromDb = nonNullExpected.filter(v => !dbValues.includes(v))
      const extraInDb = dbValues.filter(v => !nonNullExpected.includes(v))

      if (missingFromDb.length > 0) {
        logger.warn(`[schema-validator] cc_sessions.${column}: code uses values not in DB constraint [${conname}]: ${missingFromDb.join(', ')}`)
      }
      if (extraInDb.length > 0) {
        logger.info(`[schema-validator] cc_sessions.${column}: DB constraint [${conname}] allows values not in code: ${extraInDb.join(', ')}`)
      }
      if (missingFromDb.length === 0 && extraInDb.length === 0) {
        logger.info(`[schema-validator] cc_sessions.${column}: code and DB constraint [${conname}] are in sync`)
      }
    }
  } catch (err) {
    logger.warn(`[schema-validator] Failed to validate cc_sessions constraints: ${err.message}`)
  }
}

module.exports = { validateSchemaConstraints }
