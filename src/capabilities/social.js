const registry = require('../services/capabilityRegistry')

// Meta + LinkedIn social capabilities

registry.registerMany([
  // ── Meta ────────────────────────────────────────────────────────────
  {
    name: 'publish_meta_post',
    description: 'Publish a post to a Facebook or Instagram Page',
    tier: 'write',
    domain: 'meta',
    params: {
      pageId: { type: 'string', required: true, description: 'Internal meta_pages.id (UUID) — get from the Meta workspace page list' },
      message: { type: 'string', required: true, description: 'Post text content' },
      link: { type: 'string', required: false, description: 'URL to attach' },
      imageUrl: { type: 'string', required: false, description: 'Image URL to include' },
    },
    handler: async (params) => {
      const meta = require('../services/metaService')
      const result = await meta.publishPost(params.pageId, {
        message: params.message,
        link: params.link,
        imageUrl: params.imageUrl,
      })
      return { message: `Posted to page ${params.pageId}`, postId: result?.postId }
    },
  },
  {
    name: 'send_meta_message',
    description: 'Send a message in a Meta Messenger or Instagram conversation',
    tier: 'write',
    domain: 'meta',
    params: {
      conversationId: { type: 'string', required: true, description: 'Conversation ID' },
      message: { type: 'string', required: true, description: 'Message text' },
    },
    handler: async (params) => {
      const meta = require('../services/metaService')
      const result = await meta.sendMessage(params.conversationId, params.message)
      return { message: 'Message sent', messageId: result?.messageId }
    },
  },
  {
    name: 'reply_to_meta_comment',
    description: 'Reply to a comment on a Meta post',
    tier: 'write',
    domain: 'meta',
    params: {
      commentId: { type: 'string', required: true, description: 'Comment ID' },
      pageId: { type: 'string', required: true, description: 'Page ID' },
      message: { type: 'string', required: true, description: 'Reply text' },
    },
    handler: async (params) => {
      const meta = require('../services/metaService')
      await meta.replyToComment(params.commentId, params.pageId, params.message)
      return { message: 'Comment reply posted' }
    },
  },

  // ── LinkedIn ─────────────────────────────────────────────────────────
  {
    name: 'send_linkedin_reply',
    description: 'Send a reply to a LinkedIn DM using the stored draft (generate draft first if needed)',
    tier: 'write',
    domain: 'linkedin',
    params: {
      dmId: { type: 'string', required: true, description: 'LinkedIn DM internal UUID' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      // sendDMReply uses the draft_reply stored on the DM record in the DB
      await linkedin.sendDMReply(params.dmId)
      return { message: `LinkedIn reply sent to DM ${params.dmId}` }
    },
  },
  {
    name: 'draft_linkedin_reply',
    description: 'Generate an AI draft reply for a LinkedIn DM and save it to the record',
    tier: 'read',
    domain: 'linkedin',
    params: {
      dmId: { type: 'string', required: true, description: 'LinkedIn DM internal UUID' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      // draftDMReply generates and saves the draft to the DM record
      const draft = await linkedin.draftDMReply(params.dmId)
      return { draft, dmId: params.dmId }
    },
  },
])
