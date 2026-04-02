const logger = require('../config/logger')
const db = require('../config/db')
const deepseekService = require('./deepseekService')
const kg = require('./knowledgeGraphService')

// ═══════════════════════════════════════════════════════════════════════
// CORTEX SERVICE
//
// The conversational intelligence layer. Handles multi-turn chat,
// structured output blocks, action execution, and proactive briefings.
// Every exchange feeds the knowledge graph — conversation IS memory.
// ═══════════════════════════════════════════════════════════════════════

const CORTEX_SYSTEM_PROMPT = `You are The Cortex — the intelligence layer of Ecodia OS, Tate Donohoe's personal operating system. You are not a chatbot. You are a neural extension of Tate's awareness.

You have access to Tate's knowledge graph — every person, project, email, decision, and connection in his professional world. You speak in present tense, direct prose. You don't ask unnecessary clarifying questions. You act on what you know and surface what matters.

CRITICAL: You must respond with a JSON array of structured blocks. Each block has a "type" and type-specific fields. Available block types:

1. "text" — narrative prose. Fields: { "type": "text", "content": "..." }
2. "action_card" — a pending action for Tate to approve/decline. Fields: { "type": "action_card", "title": "...", "description": "...", "action": "...", "params": {...}, "urgency": "low|medium|high" }
   - action values: "send_email", "archive_email", "create_task", "update_crm_stage", "draft_reply", "create_calendar_event", "start_cc_session", "create_doc", "append_to_doc", "create_sheet", "write_sheet", "append_to_sheet", "upload_file", "search_drive", "move_file", "rename_file", "create_folder", "share_file", "delete_file", "publish_post", "send_meta_message", "reply_to_comment", "like_post", "send_linkedin_reply", "trigger_vercel_build", "sync_xero"
   - create_doc params: { title, content?, folderId? }
   - append_to_doc params: { documentId, content }
   - create_sheet params: { title, sheets?: [{title}], folderId? }
   - write_sheet params: { spreadsheetId, range, values: [[row1col1, row1col2], [row2col1, row2col2]] }
   - append_to_sheet params: { spreadsheetId, range, values: [[...]] }
   - upload_file params: { name, mimeType?, content, folderId? }
   - search_drive params: { query, limit? }
   - move_file params: { fileId, folderId } — move a Drive file to a folder
   - rename_file params: { fileId, name } — rename a Drive file
   - create_folder params: { name, parentFolderId? } — create a Drive folder
   - share_file params: { fileId, email, role?, type? } — share a Drive file
   - delete_file params: { fileId } — delete a Drive file
   - publish_post params: { pageId, message, link?, imageUrl? } — publish to Facebook/Instagram page
   - send_meta_message params: { conversationId, message } — send a Messenger/Instagram DM reply
   - reply_to_comment params: { commentId, pageId, message } — reply to a Facebook/Instagram comment
   - like_post params: { postId, pageId } — like a Facebook/Instagram post
   - send_linkedin_reply params: { dmId } — send a prepared LinkedIn DM reply
   - trigger_vercel_build params: { projectId? } — trigger a Vercel redeployment
   - sync_xero params: {} — trigger a Xero transaction sync
   - create_calendar_event params: { summary, startTime, endTime, description?, location?, attendees?, calendar? }. IMPORTANT: startTime/endTime must BOTH be date-only ("2026-04-05") for all-day events OR BOTH be dateTime ("2026-04-05T09:00:00") — never mix them.
3. "email_card" — an email summary. Fields: { "type": "email_card", "threadId": "...", "from": "...", "subject": "...", "summary": "...", "priority": "...", "receivedAt": "..." }
4. "task_card" — a task. Fields: { "type": "task_card", "title": "...", "description": "...", "priority": "low|medium|high|urgent", "source": "cortex" }
5. "status_update" — something the system did. Fields: { "type": "status_update", "message": "...", "count": number|null }
6. "insight" — a proactive observation. Fields: { "type": "insight", "message": "...", "urgency": "low|medium|high" }

RULES:
- Always start with a "text" block for the main narrative
- Use action_cards when Tate asks you to DO something (reply to email, move a client, create a task)
- Use email_cards when discussing specific emails
- Use task_cards when Tate wants to create a reminder or todo
- Use insights when you notice something Tate should know about — especially predictions, contradictions, and narrative shifts
- Use status_updates to report on autonomous actions
- Keep prose concise, direct, present-tense. No corporate fluff. No filler.
- If you don't have enough information in the knowledge graph, say so plainly
- When referencing people, include what you know about their role and relationship to Tate
- Include specific details — names, dates, decisions, status

AVAILABLE INTEGRATIONS:
- Gmail: Read, archive, reply, draft, send. Emails are auto-triaged by AI.
- Google Calendar: Read events, create/update/delete events, Google Meet auto-added. Upcoming meetings trigger AI prep reminders.
- Google Drive: Full read/write — create docs, sheets, upload files, move, rename, share, delete, create folders. Content is extracted and fed into the knowledge graph.
- LinkedIn: DM reading, AI triage, draft replies, send replies, profile scraping, connection requests, post publishing, lead scoring.
- Meta (Facebook/Instagram): Page management, post publishing, comment replies, Messenger/Instagram DM replies, DM triage, post likes.
- Vercel: Deployment monitoring, build logs, error surfacing. Build failures auto-surface to action queue.
- Xero: Transaction sync, AI categorization. Low-confidence categorizations surface to action queue.
- CRM: Client/project management. Stage changes trigger AI-driven follow-up actions and optional CC sessions.
- Factory (Claude Code): Autonomous code sessions with full oversight pipeline. Can be triggered from any integration.
- Knowledge Graph: Neo4j-backed institutional memory. Every integration feeds into it. Semantic search, narrative arcs, predictions.
- Action Queue: Universal inbox for AI-prepared actions. Every integration surfaces items here.

SPECIAL NODE TYPES IN THE KNOWLEDGE GRAPH:
The graph contains synthesized intelligence nodes created by the consolidation engine:
- Narrative nodes: Story arcs for people/projects with trajectory (ascending/pivoting/stalling) and open questions. Reference these when asked about someone's overall story.
- Prediction nodes: Pattern-based forecasts (LIKELY_NEXT edges). Surface these proactively as insights when relevant. Flag expired predictions.
- Episode nodes: Temporal groupings (e.g., "Tom strategy session", "Email triage batch"). Reference these for "what happened during X" questions.
- Contradiction/Supersedes edges: Where beliefs have shifted. Always surface these — "Tom's position on this has changed: originally X, now Y."
- Pattern/Strategic_Direction nodes: Higher-order themes abstracted from repeated patterns.
- Importance scores (0-1): Every node has one. Prioritize high-importance nodes in your responses.

Respond with ONLY a valid JSON array of blocks. No markdown, no wrapping, just the array.`

/**
 * Process a multi-turn chat message.
 * Takes full conversation history, retrieves KG context for the latest message,
 * and returns structured blocks.
 */
async function chat(messages, { sessionId } = {}) {
  const userMessage = messages.filter(m => m.role === 'user').pop()
  if (!userMessage) throw new Error('No user message provided')

  const query = userMessage.content

  // 1. Retrieve KG context for the latest user message
  let kgContext = ''
  try {
    const ctx = await kg.getContext(query, { maxSeeds: 8, maxDepth: 3 })
    kgContext = ctx.summary || ''
  } catch (err) {
    logger.debug('Cortex KG retrieval failed', { error: err.message })
  }

  // 2. Gather system state for proactive awareness
  const systemState = await getSystemState()

  // 3. Build the full prompt with KG context + system state
  const systemMessage = {
    role: 'system',
    content: `${CORTEX_SYSTEM_PROMPT}

${kgContext ? `--- KNOWLEDGE GRAPH CONTEXT ---\n${kgContext}\n--- END KNOWLEDGE GRAPH ---` : '(No knowledge graph context found for this query.)'}

--- CURRENT SYSTEM STATE ---
${formatSystemState(systemState)}
--- END SYSTEM STATE ---

Current date/time: ${new Date().toISOString()}`
  }

  // 4. Build conversation with system prompt
  const fullMessages = [systemMessage, ...messages]

  // 5. Call DeepSeek
  const raw = await deepseekService.callDeepSeek(fullMessages, {
    module: 'cortex',
    skipRetrieval: true,  // We already retrieved KG context
    skipLogging: false,   // Log the conversation to KG — conversation IS memory
    sourceId: sessionId,
  })

  // 6. Parse structured blocks
  const blocks = parseBlocks(raw)

  // 7. Extract any mentioned entity names for constellation highlighting
  const mentionedNodes = extractMentionedNodes(kgContext, query)

  return { blocks, mentionedNodes, rawKgContext: kgContext }
}

/**
 * Generate a proactive briefing for when The Cortex loads.
 * Surfaces what happened since last visit, pending items, and urgent matters.
 */
async function getLoadBriefing() {
  const systemState = await getSystemState()

  const hasPendingItems =
    systemState.unreadEmails > 0 ||
    systemState.urgentEmails > 0 ||
    systemState.highEmails > 0 ||
    systemState.pendingTasks > 0

  if (!hasPendingItems && !systemState.recentActivity.length) {
    return {
      blocks: [{
        type: 'text',
        content: 'All clear. No pending items, no urgent matters. The system is calm.',
      }],
      mentionedNodes: [],
    }
  }

  // Build a briefing prompt
  const prompt = `You are The Cortex. Tate just opened the interface. Generate a brief, useful load briefing based on the current system state. Be direct — lead with what matters most.

--- CURRENT SYSTEM STATE ---
${formatSystemState(systemState)}
---

Generate a JSON array of blocks. Start with a text block summarizing the situation. Then add individual cards for anything that needs attention. Keep it tight — this is a status glance, not a report.`

  const raw = await deepseekService.callDeepSeek(
    [{ role: 'system', content: CORTEX_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
    { module: 'cortex', skipRetrieval: true, skipLogging: true }
  )

  const blocks = parseBlocks(raw)
  return { blocks, mentionedNodes: [] }
}

/**
 * Execute an action that was approved via an action_card.
 */
async function executeAction(action, params) {
  switch (action) {
    case 'send_email': {
      const [thread] = await db`SELECT * FROM email_threads WHERE id = ${params.threadId}`
      if (!thread) throw new Error('Email thread not found')
      if (!thread.draft_reply && !params.draft) throw new Error('No draft to send')

      // If a custom draft was provided, save it first
      if (params.draft) {
        await db`UPDATE email_threads SET draft_reply = ${params.draft} WHERE id = ${params.threadId}`
      }

      const gmailService = require('./gmailService')
      await gmailService.sendReply(thread.gmail_thread_id, params.draft || thread.draft_reply)
      await db`UPDATE email_threads SET status = 'replied', updated_at = now() WHERE id = ${params.threadId}`

      return { success: true, message: `Reply sent to ${thread.from_email || thread.from_name}` }
    }

    case 'draft_reply': {
      const [thread] = await db`SELECT * FROM email_threads WHERE id = ${params.threadId}`
      if (!thread) throw new Error('Email thread not found')

      const draft = await deepseekService.draftEmailReply(thread)
      await db`UPDATE email_threads SET draft_reply = ${draft}, updated_at = now() WHERE id = ${params.threadId}`

      return { success: true, message: 'Draft created', draft }
    }

    case 'archive_email': {
      const gmailService = require('./gmailService')
      if (params.threadIds && Array.isArray(params.threadIds)) {
        for (const id of params.threadIds) {
          await gmailService.archiveThread(id)
        }
        return { success: true, message: `Archived ${params.threadIds.length} emails` }
      }
      await gmailService.archiveThread(params.threadId)
      return { success: true, message: 'Email archived' }
    }

    case 'create_task': {
      const [task] = await db`
        INSERT INTO tasks (title, description, source, priority)
        VALUES (${params.title}, ${params.description || null}, 'cortex', ${params.priority || 'medium'})
        RETURNING *
      `
      return { success: true, message: `Task created: ${task.title}`, task }
    }

    case 'update_crm_stage': {
      const [client] = await db`SELECT id, stage FROM clients WHERE id = ${params.clientId}`
      if (!client) throw new Error('Client not found')

      await db.begin(async sql => {
        await sql`UPDATE clients SET stage = ${params.stage}, updated_at = now() WHERE id = ${params.clientId}`
        await sql`
          INSERT INTO pipeline_events (client_id, from_stage, to_stage, note)
          VALUES (${params.clientId}, ${client.stage}, ${params.stage}, ${params.note || 'Updated via Cortex'})
        `
      })

      return { success: true, message: `Client moved to ${params.stage}` }
    }

    case 'create_calendar_event': {
      const calendarService = require('./calendarService')
      const start = params.startTime || params.start || params.startDate
      const end = params.endTime || params.end || params.endDate
      if (!start || !end) throw new Error('Calendar event requires startTime and endTime')
      const event = await calendarService.createEvent(params.calendar || 'tate@ecodia.au', {
        summary: params.summary,
        description: params.description,
        location: params.location,
        startTime: start,
        endTime: end,
        attendees: params.attendees,
      })
      return { success: true, message: `Event created: ${event.summary}`, event }
    }

    case 'start_cc_session': {
      const triggers = require('./factoryTriggerService')
      const session = await triggers.dispatchFromCortex(params.description || params.task, {
        codebaseName: params.codebase || params.codebaseName,
        projectId: params.projectId,
      })
      return { success: true, message: `CC session started: ${session.id}`, sessionId: session.id }
    }

    case 'create_doc': {
      const driveService = require('./googleDriveService')
      const doc = await driveService.createDocument(params.account || 'tate@ecodia.au', {
        title: params.title,
        content: params.content,
        folderId: params.folderId,
      })
      return { success: true, message: `Google Doc created: ${doc.title}`, documentId: doc.documentId }
    }

    case 'create_sheet': {
      const driveService = require('./googleDriveService')
      const sheet = await driveService.createSpreadsheet(params.account || 'tate@ecodia.au', {
        title: params.title,
        sheets: params.sheets,
        folderId: params.folderId,
      })
      return { success: true, message: `Google Sheet created: ${sheet.title}`, spreadsheetId: sheet.spreadsheetId }
    }

    case 'write_sheet': {
      const driveService = require('./googleDriveService')
      const result = await driveService.writeToSheet(params.account || 'tate@ecodia.au', params.spreadsheetId, {
        range: params.range,
        values: params.values,
      })
      return { success: true, message: `Updated ${result.updatedCells} cells`, ...result }
    }

    case 'upload_file': {
      const driveService = require('./googleDriveService')
      const file = await driveService.uploadFile(params.account || 'tate@ecodia.au', {
        name: params.name,
        mimeType: params.mimeType,
        content: params.content,
        folderId: params.folderId,
      })
      return { success: true, message: `File uploaded: ${file.name}`, fileId: file.id }
    }

    case 'search_drive': {
      const driveService = require('./googleDriveService')
      const files = await driveService.searchFiles(params.query, { limit: params.limit || 10 })
      return { success: true, files }
    }

    case 'append_to_doc': {
      const driveService = require('./googleDriveService')
      const result = await driveService.appendToDocument(params.account || 'tate@ecodia.au', params.documentId, params.content)
      return { success: true, message: `Appended ${result.appended} characters`, ...result }
    }

    case 'append_to_sheet': {
      const driveService = require('./googleDriveService')
      const result = await driveService.appendToSheet(params.account || 'tate@ecodia.au', params.spreadsheetId, {
        range: params.range,
        values: params.values,
      })
      return { success: true, message: `Appended ${result.updatedCells} cells`, ...result }
    }

    case 'move_file': {
      const driveService = require('./googleDriveService')
      const result = await driveService.moveFile(params.account || 'tate@ecodia.au', params.fileId, params.folderId)
      return { success: true, message: `File moved: ${result.name}` }
    }

    case 'rename_file': {
      const driveService = require('./googleDriveService')
      const result = await driveService.renameFile(params.account || 'tate@ecodia.au', params.fileId, params.name)
      return { success: true, message: `File renamed to: ${result.name}` }
    }

    case 'create_folder': {
      const driveService = require('./googleDriveService')
      const folder = await driveService.createFolder(params.account || 'tate@ecodia.au', {
        name: params.name,
        parentFolderId: params.parentFolderId,
      })
      return { success: true, message: `Folder created: ${folder.name}`, folderId: folder.id }
    }

    case 'share_file': {
      const driveService = require('./googleDriveService')
      await driveService.shareFile(params.account || 'tate@ecodia.au', params.fileId, {
        email: params.email,
        role: params.role || 'reader',
        type: params.type || 'user',
      })
      return { success: true, message: `File shared with ${params.email}` }
    }

    case 'delete_file': {
      const driveService = require('./googleDriveService')
      await driveService.deleteFile(params.account || 'tate@ecodia.au', params.fileId)
      return { success: true, message: 'File deleted' }
    }

    case 'like_post': {
      const metaService = require('./metaService')
      await metaService.likePost(params.postId, params.pageId)
      return { success: true, message: 'Post liked' }
    }

    case 'send_linkedin_reply': {
      const linkedinService = require('./linkedinService')
      const dm = await linkedinService.sendDMReply(params.dmId)
      return { success: true, message: `LinkedIn reply sent`, dmId: params.dmId }
    }

    case 'trigger_vercel_build': {
      // Trigger a Vercel redeployment by syncing — Vercel auto-deploys on git push
      const vercelService = require('./vercelService')
      await vercelService.poll()
      return { success: true, message: 'Vercel sync triggered' }
    }

    case 'sync_xero': {
      const xeroService = require('./xeroService')
      await xeroService.pollTransactions()
      return { success: true, message: 'Xero sync complete' }
    }

    case 'publish_post': {
      const metaService = require('./metaService')
      const result = await metaService.publishPost(params.pageId, {
        message: params.message,
        link: params.link,
        imageUrl: params.imageUrl,
      })
      return { success: true, message: `Post published to ${result.pageName}`, postId: result.postId }
    }

    case 'send_meta_message': {
      const metaService = require('./metaService')
      const result = await metaService.sendMessage(params.conversationId, params.message)
      return { success: true, message: 'Message sent', messageId: result.messageId }
    }

    case 'reply_to_comment': {
      const metaService = require('./metaService')
      const result = await metaService.replyToComment(params.commentId, params.pageId, params.message)
      return { success: true, message: 'Reply posted', commentId: result.commentId }
    }

    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

// ─── Internal Helpers ──────────────────────────────────────────────────

async function getSystemState() {
  const state = {
    unreadEmails: 0,
    urgentEmails: 0,
    highEmails: 0,
    pendingTriage: 0,
    pendingTasks: 0,
    recentActivity: [],
    urgentEmailDetails: [],
    consolidation: null,
    highEmailDetails: [],
    calendarToday: [],
    calendarNext24h: 0,
    actionQueueStats: null,
    vercelStats: null,
    linkedinPending: 0,
    metaUnread: 0,
  }

  try {
    const [emailStats] = await db`
      SELECT
        count(*) FILTER (WHERE status = 'unread')::int AS unread,
        count(*) FILTER (WHERE triage_priority = 'urgent' AND status != 'archived')::int AS urgent,
        count(*) FILTER (WHERE triage_priority = 'high' AND status != 'archived')::int AS high,
        count(*) FILTER (WHERE triage_status = 'pending')::int AS pending_triage
      FROM email_threads
    `
    state.unreadEmails = emailStats?.unread || 0
    state.urgentEmails = emailStats?.urgent || 0
    state.highEmails = emailStats?.high || 0
    state.pendingTriage = emailStats?.pending_triage || 0
  } catch (err) {
    logger.debug('Cortex email stats failed', { error: err.message })
  }

  try {
    const urgentEmails = await db`
      SELECT id, subject, from_name, from_email, triage_summary, received_at, triage_priority, draft_reply
      FROM email_threads
      WHERE triage_priority IN ('urgent', 'high')
        AND status NOT IN ('archived', 'replied')
      ORDER BY
        CASE triage_priority WHEN 'urgent' THEN 0 ELSE 1 END,
        received_at DESC
      LIMIT 10
    `
    state.urgentEmailDetails = urgentEmails.filter(e => e.triage_priority === 'urgent')
    state.highEmailDetails = urgentEmails.filter(e => e.triage_priority === 'high')
  } catch (err) {
    logger.debug('Cortex urgent email fetch failed', { error: err.message })
  }

  try {
    const [taskStats] = await db`
      SELECT count(*)::int AS pending
      FROM tasks WHERE status = 'pending' OR status = 'in_progress'
    `
    state.pendingTasks = taskStats?.pending || 0
  } catch (err) {
    logger.debug('Cortex task stats failed', { error: err.message })
  }

  try {
    const recentEmails = await db`
      SELECT 'email_handled' AS type, subject AS detail, triage_priority AS priority, updated_at AS ts
      FROM email_threads
      WHERE status IN ('archived', 'replied')
        AND updated_at > now() - interval '24 hours'
      ORDER BY updated_at DESC
      LIMIT 5
    `
    state.recentActivity = recentEmails
  } catch (err) {
    logger.debug('Cortex recent activity failed', { error: err.message })
  }

  try {
    const consolidation = require('./kgConsolidationService')
    state.consolidation = await consolidation.getConsolidationStats()
  } catch (err) {
    logger.debug('Cortex consolidation stats failed', { error: err.message })
  }

  try {
    const actionQueue = require('./actionQueueService')
    state.actionQueueStats = await actionQueue.getStats()
  } catch (err) {
    logger.debug('Cortex action queue stats failed', { error: err.message })
  }

  try {
    const [vercelStats] = await db`
      SELECT
        count(*) FILTER (WHERE state = 'ERROR' AND created_at > now() - interval '24 hours')::int AS failed_24h,
        count(*) FILTER (WHERE state = 'BUILDING')::int AS building
      FROM vercel_deployments
    `
    state.vercelStats = vercelStats
  } catch (err) {
    logger.debug('Cortex vercel stats failed', { error: err.message })
  }

  try {
    const [liStats] = await db`
      SELECT count(*)::int AS pending FROM linkedin_dms
      WHERE triage_status IN ('pending', 'pending_retry') OR (status = 'unread' AND triage_status IS NULL)
    `
    state.linkedinPending = liStats?.pending || 0
  } catch (err) {
    logger.debug('Cortex linkedin stats failed', { error: err.message })
  }

  try {
    const [metaStats] = await db`
      SELECT count(*)::int AS unread FROM meta_conversations
      WHERE triage_status IS NULL OR triage_status = 'pending'
    `
    state.metaUnread = metaStats?.unread || 0
  } catch (err) {
    logger.debug('Cortex meta stats failed', { error: err.message })
  }

  try {
    const todayEvents = await db`
      SELECT id, summary, start_time, end_time, location, attendees, conference_link, all_day
      FROM calendar_events
      WHERE start_time >= date_trunc('day', now() AT TIME ZONE 'Australia/Brisbane') AT TIME ZONE 'Australia/Brisbane'
        AND start_time < date_trunc('day', now() AT TIME ZONE 'Australia/Brisbane') AT TIME ZONE 'Australia/Brisbane' + interval '1 day'
        AND status = 'confirmed'
      ORDER BY start_time ASC
    `
    state.calendarToday = todayEvents

    const [next24h] = await db`
      SELECT count(*)::int AS cnt FROM calendar_events
      WHERE start_time >= now() AND start_time <= now() + interval '24 hours'
        AND status = 'confirmed'
    `
    state.calendarNext24h = next24h?.cnt || 0
  } catch (err) {
    logger.debug('Cortex calendar fetch failed', { error: err.message })
  }

  return state
}

function formatSystemState(state) {
  const lines = []

  lines.push(`Emails: ${state.unreadEmails} unread, ${state.urgentEmails} urgent, ${state.highEmails} high priority, ${state.pendingTriage} pending triage`)
  lines.push(`Tasks: ${state.pendingTasks} pending`)
  lines.push(`Calendar: ${state.calendarNext24h} events in next 24 hours, ${state.calendarToday.length} today`)

  if (state.actionQueueStats) {
    const aq = state.actionQueueStats
    lines.push(`Action Queue: ${aq.pending} pending (${aq.urgent} urgent), ${aq.executed_24h} executed today, ${aq.dismissed_24h} dismissed today`)
  }

  if (state.vercelStats) {
    const v = state.vercelStats
    if (v.building > 0 || v.failed_24h > 0) {
      lines.push(`Vercel: ${v.building} building now, ${v.failed_24h} failed in last 24h`)
    }
  }

  if (state.linkedinPending > 0) {
    lines.push(`LinkedIn: ${state.linkedinPending} DMs pending triage`)
  }

  if (state.metaUnread > 0) {
    lines.push(`Meta DMs: ${state.metaUnread} conversations pending triage`)
  }

  if (state.calendarToday.length) {
    lines.push('\nTODAY\'S CALENDAR:')
    for (const e of state.calendarToday) {
      const time = e.all_day ? 'All day' : new Date(e.start_time).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Brisbane' })
      const attendees = typeof e.attendees === 'string' ? JSON.parse(e.attendees) : (e.attendees || [])
      const people = attendees.filter(a => !a.self).map(a => a.name || a.email).join(', ')
      lines.push(`  - ${time}: ${e.summary}${e.location ? ` @ ${e.location}` : ''}${people ? ` (with ${people})` : ''}${e.conference_link ? ' [video call]' : ''}`)
    }
  }

  if (state.urgentEmailDetails.length) {
    lines.push('\nURGENT EMAILS:')
    for (const e of state.urgentEmailDetails) {
      lines.push(`  - From: ${e.from_name || e.from_email} | Subject: ${e.subject} | Summary: ${e.triage_summary || 'No summary'} | ID: ${e.id}${e.draft_reply ? ' (draft ready)' : ''}`)
    }
  }

  if (state.highEmailDetails.length) {
    lines.push('\nHIGH PRIORITY EMAILS:')
    for (const e of state.highEmailDetails) {
      lines.push(`  - From: ${e.from_name || e.from_email} | Subject: ${e.subject} | Summary: ${e.triage_summary || 'No summary'} | ID: ${e.id}${e.draft_reply ? ' (draft ready)' : ''}`)
    }
  }

  if (state.recentActivity.length) {
    lines.push('\nRECENT AUTONOMOUS ACTIONS (last 24h):')
    for (const a of state.recentActivity) {
      lines.push(`  - ${a.type}: ${a.detail} (${a.priority})`)
    }
  }

  if (state.consolidation) {
    const c = state.consolidation
    lines.push(`\nKNOWLEDGE GRAPH HEALTH:`)
    lines.push(`  Synthesized patterns: ${c.synthesizedPatterns}, Inferred relationships: ${c.inferredRelationships}`)
    lines.push(`  Merged duplicates: ${c.totalMerged} nodes consolidated into ${c.mergedNodes}`)
    if (c.staleNodes > 0) lines.push(`  Stale nodes pending decay: ${c.staleNodes}`)
  }

  return lines.join('\n')
}

function parseBlocks(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    if (parsed.blocks && Array.isArray(parsed.blocks)) return parsed.blocks
    return [{ type: 'text', content: raw }]
  } catch {
    // Try extracting JSON from markdown code blocks
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) {
      try {
        const parsed = JSON.parse(match[1].trim())
        if (Array.isArray(parsed)) return parsed
        return [{ type: 'text', content: raw }]
      } catch {
        // Fall through
      }
    }
    // Last resort: wrap as text
    return [{ type: 'text', content: raw }]
  }
}

function extractMentionedNodes(kgContext, query) {
  if (!kgContext) return []

  const names = new Set()
  // Extract node names from KG context (format: "Name [Label]")
  const nameMatches = kgContext.matchAll(/^(?:\s*-\[.*?\]->\s*)?(.+?)\s*\[/gm)
  for (const match of nameMatches) {
    const name = match[1].trim()
    if (name && name.length > 1 && name.length < 100) {
      names.add(name)
    }
  }

  return [...names]
}

module.exports = { chat, getLoadBriefing, executeAction }
