const kg = require('./knowledgeGraphService')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// KG INGESTION HOOKS
//
// Thin async hooks called from existing services. All fire-and-forget —
// KG failures never block the main flow. The LLM decides what nodes
// and relationships to create. We just feed it content.
// ═══════════════════════════════════════════════════════════════════════

function isEnabled() {
  return !!(env.NEO4J_URI && env.DEEPSEEK_API_KEY)
}

// ─── Immediate Memory Sync Helper ──────────────────────────────────
// After any ingestion that produces a high-importance node, sync it
// to the organism immediately rather than waiting for the 30-min sweep.
// Fire-and-forget, non-blocking.

async function trySyncImportant(nodeName, labels, properties) {
  try {
    const memBridge = require('./memoryBridgeService')
    const importance = properties?.importance || 0
    if (importance >= 0.9) {
      await memBridge.syncImmediateIfUrgent({ name: nodeName, labels, importance, properties })
    } else if (importance >= 0.7) {
      await memBridge.syncImmediateIfImportant({ name: nodeName, labels, importance, properties })
    }
  } catch {}
}

// ─── Gmail ───────────────────────────────────────────────────────────

async function onEmailProcessed({ threadId, fromEmail, fromName, subject, body, snippet, inbox, clientId }) {
  if (!isEnabled()) return

  try {
    // Always create the person node immediately (cheap, no LLM)
    await kg.ensureNode({
      label: 'Person',
      name: fromName || fromEmail,
      properties: { email: fromEmail },
      sourceModule: 'gmail',
    })

    // LLM ingestion for rich extraction — runs async
    const content = `Email received in ${inbox} inbox.
From: ${fromName || 'Unknown'} <${fromEmail}>
Subject: ${subject}
Body: ${(body || snippet || '').slice(0, 2000)}`

    const context = clientId ? 'Sender is a known CRM client.' : ''

    await kg.ingestFromLLM(content, {
      sourceModule: 'gmail',
      sourceId: threadId,
      context,
    })
  } catch (err) {
    logger.debug('KG email ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onEmailTriaged({ threadId, subject, fromEmail, triageSummary, triageAction, triagePriority }) {
  if (!isEnabled()) return

  try {
    const content = `Email triage result:
Subject: ${subject}
From: ${fromEmail}
Priority: ${triagePriority}
Summary: ${triageSummary}
Suggested action: ${triageAction}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'gmail_triage',
      sourceId: threadId,
      context: 'This is an AI triage result for an email. Extract any new entities, topics, or relationships mentioned in the summary.',
    })
  } catch (err) {
    logger.debug('KG triage ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onEmailSnoozed({ threadId, subject, fromEmail, summary }) {
  if (!isEnabled()) return

  try {
    const content = `Repeated email signal snoozed (auto-handled, not surfaced to human):
Subject: ${subject}
From: ${fromEmail}
Summary: ${summary}
Action: System archived this as a repeated signal about a known topic. No human attention needed.`

    await kg.ingestFromLLM(content, {
      sourceModule: 'gmail_snooze',
      sourceId: threadId,
      context: 'This email was a repeat notification about something already acknowledged. Record that this topic continues to generate signals — useful for tracking unresolved recurring items.',
    })
  } catch (err) {
    logger.debug('KG snooze ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── LinkedIn ────────────────────────────────────────────────────────

async function onLinkedInDMProcessed({ dm }) {
  if (!isEnabled()) return

  try {
    const messages = (dm.messages || []).slice(-5)
    const content = `LinkedIn DM conversation with ${dm.participant_name}${dm.participant_headline ? ' (' + dm.participant_headline + ')' : ''}:
${messages.map(m => `${m.sender}: ${m.text}`).join('\n')}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'linkedin_dm',
      sourceId: dm.id,
      context: dm.participant_company ? `Works at ${dm.participant_company}` : '',
    })
  } catch (err) {
    logger.debug('KG LinkedIn DM ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onLinkedInProfileProcessed({ profile }) {
  if (!isEnabled()) return

  try {
    await kg.ensureNode({
      label: 'Person',
      name: profile.name,
      properties: {
        linkedin_url: profile.linkedin_url,
        headline: profile.headline,
        company: profile.company,
        location: profile.location,
        industry: profile.industry,
      },
      sourceModule: 'linkedin_profile',
      sourceId: profile.id,
    })

    if (profile.company) {
      await kg.ensureRelationship({
        fromLabel: 'Person',
        fromName: profile.name,
        toLabel: 'Organisation',
        toName: profile.company,
        relType: 'WORKS_AT',
        properties: { title: profile.headline },
        sourceModule: 'linkedin_profile',
      })
    }
  } catch (err) {
    logger.debug('KG LinkedIn profile ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── CRM ─────────────────────────────────────────────────────────────

async function onClientUpdated({ client, previousStage }) {
  if (!isEnabled()) return

  try {
    await kg.ensureNode({
      label: 'Person',
      name: client.name,
      properties: {
        email: client.email,
        company: client.company,
        phone: client.phone,
        stage: client.stage,
        priority: client.priority,
      },
      sourceModule: 'crm',
      sourceId: client.id,
    })

    if (client.company) {
      await kg.ensureRelationship({
        fromLabel: 'Person',
        fromName: client.name,
        toLabel: 'Organisation',
        toName: client.company,
        relType: 'WORKS_AT',
        sourceModule: 'crm',
      })
    }

    if (previousStage && previousStage !== client.stage) {
      await kg.ensureRelationship({
        fromLabel: 'Person',
        fromName: client.name,
        toLabel: 'Event',
        toName: `Pipeline: ${previousStage} → ${client.stage}`,
        relType: 'MOVED_STAGE',
        properties: { from: previousStage, to: client.stage, when: new Date().toISOString() },
        sourceModule: 'crm',
      })
    }
  } catch (err) {
    logger.debug('KG CRM ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onProjectCreated({ project, clientName }) {
  if (!isEnabled()) return

  try {
    await kg.ensureNode({
      label: 'Project',
      name: project.name,
      properties: {
        description: project.description,
        status: project.status,
        tech_stack: (project.tech_stack || []).join(', '),
        repo_url: project.repo_url,
        budget: project.budget_aud,
      },
      sourceModule: 'crm',
      sourceId: project.id,
    })

    if (clientName) {
      await kg.ensureRelationship({
        fromLabel: 'Person',
        fromName: clientName,
        toLabel: 'Project',
        toName: project.name,
        relType: 'OWNS',
        sourceModule: 'crm',
      })
    }
  } catch (err) {
    logger.debug('KG project ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Finance ─────────────────────────────────────────────────────────

async function onTransactionCategorized({ transaction, clientName }) {
  if (!isEnabled()) return

  try {
    if (clientName && transaction.category) {
      await kg.ensureRelationship({
        fromLabel: 'Person',
        fromName: clientName,
        toLabel: 'Transaction',
        toName: `${transaction.description} ($${Math.abs(transaction.amount_aud)})`,
        relType: transaction.type === 'credit' ? 'PAID' : 'WAS_PAID_FOR',
        properties: {
          amount: transaction.amount_aud,
          category: transaction.category,
          date: transaction.date,
        },
        sourceModule: 'finance',
      })
    }
  } catch (err) {
    logger.debug('KG finance ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Calendar ───────────────────────────────────────────────────────

async function onCalendarEventProcessed({ event, calendarEmail }) {
  if (!isEnabled()) return
  if (!event.summary) return // skip empty events

  try {
    // Create person nodes for attendees
    const attendees = typeof event.attendees === 'string' ? JSON.parse(event.attendees) : (event.attendees || [])
    for (const att of attendees) {
      if (att.email && !att.self && att.email !== calendarEmail) {
        await kg.ensureNode({
          label: 'Person',
          name: att.name || att.email,
          properties: { email: att.email },
          sourceModule: 'calendar',
        })
      }
    }

    const attendeeNames = attendees
      .filter(a => !a.self && a.email !== calendarEmail)
      .map(a => a.name || a.email)
      .join(', ')

    const content = `Calendar event: ${event.summary}
When: ${event.start_time}${event.all_day ? ' (all day)' : ` to ${event.end_time}`}
${event.location ? `Location: ${event.location}` : ''}
${attendeeNames ? `Attendees: ${attendeeNames}` : ''}
${event.description ? `Description: ${(event.description || '').slice(0, 1000)}` : ''}
Calendar: ${calendarEmail}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'calendar',
      sourceId: event.id,
      context: 'This is a calendar event. Extract people, topics, meeting purposes, and any relationships between attendees.',
    })
  } catch (err) {
    logger.debug('KG calendar ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Claude Code Sessions ────────────────────────────────────────────

async function onCCSessionCompleted({ session, projectName }) {
  if (!isEnabled()) return

  try {
    const content = `Claude Code session completed.
Project: ${projectName || 'Unknown'}
Prompt: ${session.initial_prompt}
Status: ${session.status}
Cost: $${session.cc_cost_usd || 0}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'claude_code',
      sourceId: session.id,
      context: projectName ? `This was work on the ${projectName} project.` : '',
    })

    // Immediate sync: CC session outcomes are high-value for organism's Evo
    trySyncImportant(
      `CC Session: ${(session.initial_prompt || '').slice(0, 60)}`,
      ['CCSession'],
      { importance: session.status === 'error' ? 0.8 : 0.7, status: session.status, project: projectName },
    )
  } catch (err) {
    logger.debug('KG CC session ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Codebase Intelligence ──────────────────────────────────────────

async function onCodebaseIndexed({ codebaseId, codebaseName, language, fileCount }) {
  if (!isEnabled()) return

  try {
    await kg.ensureNode({
      label: 'Codebase',
      name: codebaseName,
      properties: { language, file_count: fileCount },
      sourceModule: 'codebase_intelligence',
      sourceId: codebaseId,
    })
  } catch (err) {
    logger.debug('KG codebase ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Deployments ────────────────────────────────────────────────────

async function onDeploymentCompleted({ deployment, codebaseName, sessionId }) {
  if (!isEnabled()) return

  try {
    const content = `Deployment to ${codebaseName}.
Commit: ${deployment.commit_sha}
Status: ${deployment.deploy_status}
Target: ${deployment.deploy_target}
${deployment.error_message ? `Error: ${deployment.error_message}` : ''}
${deployment.reverted_at ? 'This deployment was REVERTED due to failure.' : ''}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'deployment',
      sourceId: deployment.id,
      context: `Deployment from CC session ${sessionId} to the ${codebaseName} codebase.`,
    })

    // Deploy failures are urgent — organism's Thymos needs to know immediately
    const isFailure = deployment.deploy_status === 'failed' || deployment.deploy_status === 'reverted'
    trySyncImportant(
      `Deploy: ${codebaseName} — ${deployment.deploy_status}`,
      ['Deployment'],
      { importance: isFailure ? 0.9 : 0.7, status: deployment.deploy_status, codebase: codebaseName },
    )
  } catch (err) {
    logger.debug('KG deployment ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Google Drive ────────────────────────────────────────────────────

async function onDriveFileProcessed({ file }) {
  if (!isEnabled()) return

  try {
    const contentPreview = (file.content_text || '').slice(0, 2000)

    await kg.ensureNode({
      label: 'Document',
      name: file.name,
      properties: {
        source: 'google_drive',
        mime_type: file.mime_type,
        folder: file.parent_folder_name,
        owner: file.owner_email,
        web_link: file.web_view_link,
        last_modified: file.modified_time,
        last_modified_by: file.last_modifying_user,
      },
      sourceModule: 'google_drive',
      sourceId: file.id,
    })

    if (contentPreview) {
      await kg.ingestFromLLM(
        `Google Drive document: ${file.name}
Type: ${file.mime_type}
Folder: ${file.parent_folder_name || 'root'}
Owner: ${file.owner_email || 'unknown'}
Last modified by: ${file.last_modifying_user || 'unknown'}

Content:
${contentPreview}`, {
          sourceModule: 'google_drive',
          sourceId: file.id,
          context: 'This is a Google Drive document. Extract entities, topics, decisions, action items, and any relationships between people or projects mentioned.',
        }
      )
    }
  } catch (err) {
    logger.debug('KG Drive ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Vercel ─────────────────────────────────────────────────────────

async function onVercelDeployment({ deployment, projectName }) {
  if (!isEnabled()) return

  try {
    const content = `Vercel deployment: ${projectName || deployment.name}
State: ${deployment.state}
Target: ${deployment.target || 'preview'}
Branch: ${deployment.meta?.githubCommitRef || 'unknown'}
Commit: ${deployment.meta?.githubCommitMessage || 'no message'}
${deployment.state === 'ERROR' ? `Error: ${deployment.errorMessage || 'unknown'}` : ''}
URL: ${deployment.url ? `https://${deployment.url}` : 'N/A'}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'vercel',
      sourceId: deployment.uid,
      context: `Vercel deployment for the ${projectName || deployment.name} project. Track deployment patterns, failures, and which branches are being deployed.`,
    })
  } catch (err) {
    logger.debug('KG Vercel ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Meta / Facebook ────────────────────────────────────────────────

async function onMetaPostCreated({ post, pageName }) {
  if (!isEnabled()) return

  try {
    if (!post.message && !post.story) return

    const content = `Facebook/Instagram post on ${pageName || 'page'}:
${post.message || post.story || ''}
Type: ${post.type || 'unknown'}
Engagement: ${post.likes?.summary?.total_count || 0} likes, ${post.comments?.summary?.total_count || 0} comments, ${post.shares?.count || 0} shares`

    await kg.ingestFromLLM(content, {
      sourceModule: 'meta',
      sourceId: post.id,
      context: 'This is a social media post. Extract topics, mentions, and any business-relevant content.',
    })
  } catch (err) {
    logger.debug('KG Meta post ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onMetaConversationUpdated({ conversation, participantName, platform, newMessageCount }) {
  if (!isEnabled()) return

  try {
    await kg.ensureNode({
      label: 'Person',
      name: participantName || conversation.participant_id || 'Unknown',
      properties: {
        [`${platform}_id`]: conversation.participant_id,
        platform,
      },
      sourceModule: `meta_${platform}`,
      sourceId: conversation.id,
    })

    // We don't ingest message content to KG to avoid privacy issues with DMs
    // Just track the relationship
    await kg.ensureRelationship({
      fromLabel: 'Person',
      fromName: participantName || conversation.participant_id,
      toLabel: 'Event',
      toName: `${platform} conversation (${newMessageCount} new messages)`,
      relType: 'MESSAGED_VIA',
      properties: { platform, lastMessageAt: conversation.last_message_at },
      sourceModule: `meta_${platform}`,
    })
  } catch (err) {
    logger.debug('KG Meta conversation ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Symbridge Messages ─────────────────────────────────────────────

async function onSymbridgeMessage({ direction, messageType, payload, sourceSystem, correlationId }) {
  if (!isEnabled()) return

  try {
    const content = `Symbridge message (${direction}):
Type: ${messageType}
Source: ${sourceSystem}
${correlationId ? `Correlation: ${correlationId}` : ''}
Payload: ${JSON.stringify(payload).slice(0, 1500)}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'symbridge',
      sourceId: correlationId || null,
      context: `This is a ${direction} symbridge message between the organism and EcodiaOS. Track communication patterns, proposals, results, and health signals between the two bodies.`,
    })
  } catch (err) {
    logger.debug('KG symbridge ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Action Queue ───────────────────────────────────────────────────

async function onActionDismissed({ action, reason }) {
  if (!isEnabled()) return

  try {
    const content = `Action dismissed by human:
Source: ${action.source}
Type: ${action.action_type}
Title: ${action.title}
Summary: ${action.summary || 'N/A'}
Priority: ${action.priority}
Surfaced because: ${action.context?.surfacedBecause || 'ai_requested'}
Confidence when surfaced: ${action.context?.confidence ?? 'unknown'}
Dismiss reason: ${reason || 'no reason given'}
From: ${action.context?.from || 'unknown'} (${action.context?.email || ''})`

    await kg.ingestFromLLM(content, {
      sourceModule: 'action_queue_dismissed',
      sourceId: action.id,
      context: 'A human dismissed this action — they chose NOT to act on it. This is a correction signal. Extract: what kind of item was rejected, from whom, why it was probably wrong to surface, and what pattern this represents about Tate\'s preferences.',
    })
  } catch (err) {
    logger.debug('KG action dismissed ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onActionExecuted({ action, result }) {
  if (!isEnabled()) return

  try {
    const content = `Action executed:
Source: ${action.source}
Type: ${action.action_type}
Title: ${action.title}
Summary: ${action.summary || 'N/A'}
Priority: ${action.priority}
Result: ${result?.message || 'completed'}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'action_queue',
      sourceId: action.id,
      context: 'An action from the unified action queue was approved and executed. Track patterns of what gets approved vs dismissed.',
    })

    // Cognitive broadcast: tell the organism an action was executed
    sendCognitiveBroadcast('action_outcome', 0.4, {
      source: action.source,
      action_type: action.action_type,
      title: action.title,
      result: result?.message,
    })
  } catch (err) {
    logger.debug('KG action queue ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Direct Actions (organism → integration without CC) ─────────────

async function onDirectAction({ actionType, params, result, status, durationMs }) {
  if (!isEnabled()) return

  try {
    const content = `Direct action executed (no CC session):
Type: ${actionType}
Status: ${status}
Duration: ${durationMs}ms
Result: ${JSON.stringify(result).slice(0, 500)}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'direct_action',
      context: 'A direct action was executed by the organism through EcodiaOS without a Factory CC session. Track which direct actions are used and their outcomes.',
    })
  } catch (err) {
    logger.debug('KG direct action ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Factory Outcome with Immediate Sync ────────────────────────────

async function onFactoryOutcome({ session, outcome, confidence, filesChanged, commitSha, error }) {
  if (!isEnabled()) return

  // Sync Factory outcomes to organism immediately — Evo needs this for hypothesis formation
  try {
    const memBridge = require('./memoryBridgeService')
    await memBridge.syncImmediateIfImportant({
      name: `Factory: ${outcome} — ${(session.initial_prompt || '').slice(0, 60)}`,
      labels: ['FactoryOutcome'],
      importance: outcome === 'success' ? 0.7 : outcome === 'deploy_failed' ? 0.9 : 0.6,
      properties: {
        outcome,
        confidence,
        codebase: session.codebase_name,
        trigger: session.trigger_source,
        files_changed: (filesChanged || []).slice(0, 10).join(', '),
      },
    })
  } catch {}

  // Cognitive broadcast to organism's Atune
  sendCognitiveBroadcast('factory_outcome', confidence || 0.5, {
    session_id: session.id,
    outcome,
    codebase: session.codebase_name,
    files_changed: filesChanged,
    commit_sha: commitSha,
    error,
  })
}

// ─── System Events (maintenance cycles, worker signals) ─────────────

async function onSystemEvent({ type, decisions, actioned, pressure }) {
  if (!isEnabled()) return

  try {
    const content = `System event: ${type}
${decisions !== undefined ? `Decisions made: ${decisions}, actioned: ${actioned}` : ''}
${pressure !== undefined ? `Metabolic pressure: ${pressure}` : ''}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'system',
      context: 'This is an internal system event from the autonomous maintenance loop. Track system health patterns over time.',
    })
  } catch (err) {
    logger.debug('KG system event ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Cognitive Broadcast Helper ─────────────────────────────────────
// Sends structured percepts to the organism's cognitive cycle (Atune)

function sendCognitiveBroadcast(perceptType, salience, content) {
  if (env.COGNITIVE_BROADCAST_ENABLED === 'false') return

  try {
    const symbridge = require('./symbridgeService')
    symbridge.send('cognitive_broadcast', {
      percept_type: perceptType,
      salience: Math.max(0, Math.min(1, salience)),
      content,
      source: 'ecodiaos',
      timestamp: new Date().toISOString(),
    }).catch(() => {})
  } catch {}
}

module.exports = {
  onEmailProcessed,
  onEmailTriaged,
  onEmailSnoozed,
  onLinkedInDMProcessed,
  onLinkedInProfileProcessed,
  onClientUpdated,
  onProjectCreated,
  onTransactionCategorized,
  onCalendarEventProcessed,
  onCCSessionCompleted,
  onCodebaseIndexed,
  onDeploymentCompleted,
  onDriveFileProcessed,
  onVercelDeployment,
  onMetaPostCreated,
  onMetaConversationUpdated,
  onSymbridgeMessage,
  onActionDismissed,
  onActionExecuted,
  onDirectAction,
  onFactoryOutcome,
  onSystemEvent,
  sendCognitiveBroadcast,
}
