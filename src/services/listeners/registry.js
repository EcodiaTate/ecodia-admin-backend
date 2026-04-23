'use strict'

/**
 * Listener registry — loads, validates, and dispatches to in-process event listeners.
 *
 * Listeners are JS modules in src/services/listeners/ (excluding index.js and registry.js).
 * Each module must export: { name, subscribesTo, relevanceFilter, handle, ownsWriteSurface }
 *
 * Dispatch guarantees:
 *   - relevanceFilter called synchronously; false = skip handle
 *   - per-listener concurrency cap of 1: new events dropped (not queued) if handler is in-flight
 *   - handler throws are caught and logged at warn; never propagate
 *   - listeners that import osSessionService are rejected at load time
 */

const path = require('path')
const fs = require('fs')
const logger = require('../../config/logger')

let _listeners = []
const _inFlight = new Map() // listener name -> boolean

function loadListeners() {
  const dir = __dirname
  let files
  try {
    files = fs.readdirSync(dir).filter(f => {
      if (!f.endsWith('.js')) return false
      if (f === 'index.js' || f === 'registry.js') return false
      return true
    })
  } catch (err) {
    logger.warn('listener subsystem: could not scan listeners dir', { error: err.message })
    _listeners = []
    return []
  }

  const loaded = []
  for (const file of files) {
    const filePath = path.join(dir, file)
    try {
      // Boot-time validation: reject modules that import osSessionService
      const content = fs.readFileSync(filePath, 'utf-8')
      if (content.includes('osSessionService')) {
        logger.warn(`listener: rejected ${file} — imports osSessionService (forbidden)`)
        continue
      }

      const mod = require(filePath)
      if (!mod || typeof mod !== 'object') {
        logger.warn(`listener: skipped ${file} — module did not export an object`)
        continue
      }

      const missing = []
      if (!mod.name) missing.push('name')
      if (!Array.isArray(mod.subscribesTo)) missing.push('subscribesTo')
      if (typeof mod.handle !== 'function') missing.push('handle')
      if (typeof mod.relevanceFilter !== 'function') missing.push('relevanceFilter')

      if (missing.length > 0) {
        logger.warn(`listener: skipped ${file} — missing required fields: ${missing.join(', ')}`)
        continue
      }

      loaded.push(mod)
      logger.info(`listener: loaded ${mod.name} (subscribesTo: ${mod.subscribesTo.join(', ')})`)
    } catch (err) {
      logger.warn(`listener: failed to load ${file}`, { error: err.message })
    }
  }

  _listeners = loaded
  return loaded
}

/**
 * Dispatch an event to a set of listeners (all loaded listeners by default).
 * Accepts an optional second argument for test injection.
 */
async function dispatch(event, _testListeners) {
  const targets = _testListeners || _listeners

  for (const listener of targets) {
    const types = Array.isArray(listener.subscribesTo) ? listener.subscribesTo : [listener.subscribesTo]
    // Match the semantic inner type first (e.g. 'text_delta' inside an 'os-session:output'
    // envelope), fall back to the outer envelope type for channels that don't wrap a data.type.
    const innerType = event && event.data && event.data.type
    const matched = (innerType && types.includes(innerType)) || types.includes(event.type)
    if (!matched) continue

    // Relevance filter — synchronous
    let relevant = false
    try {
      relevant = listener.relevanceFilter(event)
    } catch (err) {
      logger.warn(`listener ${listener.name}: relevanceFilter threw`, { error: err.message })
      continue
    }
    if (!relevant) continue

    // Concurrency cap — drop if handler already in-flight
    if (_inFlight.get(listener.name)) {
      logger.info(`listener ${listener.name}: dropping event (concurrency cap, handler in-flight)`, { type: event.type })
      continue
    }

    const sourceEventId = event.ws_seq != null
      ? String(event.ws_seq)
      : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const ctx = { sourceEventId }

    _inFlight.set(listener.name, true)
    try {
      await listener.handle(event, ctx)
    } catch (err) {
      logger.warn(`listener ${listener.name}: handler threw`, { error: err.message })
    } finally {
      _inFlight.delete(listener.name)
    }
  }
}

/**
 * Register all loaded listeners with the wsManager's in-process subscribe().
 * Accepts an optional wsManager override for tests.
 *
 * NOTE: wsManager fan-out emits on channel keys (currently only 'os-session:output'),
 * NOT on envelope.type. Listeners declare subscribesTo in envelope-type terms
 * (e.g. 'text_delta'); dispatch() does the envelope.type filter. If more fan-out
 * channels are added later, extend WS_CHANNELS + route per-listener.
 */
const WS_CHANNELS = ['os-session:output']

function registerAll(_wsManager) {
  const wsMgr = _wsManager || require('../../websocket/wsManager')

  let registered = 0
  for (const listener of _listeners) {
    // Subscribe each listener to the channel; envelope.type filtering happens in dispatch()
    const l = listener
    wsMgr.subscribe(WS_CHANNELS, async (event) => {
      await dispatch(event, [l])
    })
    registered++
  }

  logger.info(`listener subsystem: registered ${registered} listeners on channels [${WS_CHANNELS.join(', ')}]`)
  return registered
}

function getListeners() {
  return _listeners
}

module.exports = { loadListeners, registerAll, dispatch, getListeners }
