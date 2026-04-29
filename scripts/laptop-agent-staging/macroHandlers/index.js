// macroHandlers/index.js
// Barrel for the macro dispatcher. Add new handlers here when authored.
// Authored by fork_mojldsgx_7b55bf, 29 Apr 2026.
// Updated by fork_mojlth0k_2b4be6, 29 Apr 2026: + xcode-organizer-upload, transporter-upload.

const apple = require('./apple-signin')
const vercel = require('./vercel-login')
const coexist = require('./coexist-admin-signin')
const xcodeOrganizerUpload = require('./xcode-organizer-upload')
const transporterUpload = require('./transporter-upload')

const HANDLERS = {
  [apple.name]: apple,
  [vercel.name]: vercel,
  [coexist.name]: coexist,
  [xcodeOrganizerUpload.name]: xcodeOrganizerUpload,
  [transporterUpload.name]: transporterUpload,
}

module.exports = { HANDLERS }
