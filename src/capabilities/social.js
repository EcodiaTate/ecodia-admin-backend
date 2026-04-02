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
      pageId: { type: 'string', required: true, description: 'Facebook Page ID' },
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
    description: 'Send a reply to a LinkedIn DM using the prepared draft',
    tier: 'write',
    domain: 'linkedin',
    params: {
      dmId: { type: 'string', required: true, description: 'LinkedIn DM ID' },
      draft: { type: 'string', required: false, description: 'Override prepared draft text' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      await linkedin.sendReply(params.dmId, params.draft)
      return { message: `LinkedIn reply sent to DM ${params.dmId}` }
    },
  },
  {
    name: 'draft_linkedin_reply',
    description: 'Generate an AI draft reply for a LinkedIn DM using KG context',
    tier: 'read',
    domain: 'linkedin',
    params: {
      dmId: { type: 'string', required: true, description: 'LinkedIn DM ID' },
    },
    handler: async (params) => {
      const linkedin = require('../services/linkedinService')
      const draft = await linkedin.generateDraftReply(params.dmId)
      return { draft, dmId: params.dmId }
    },
  },
])
