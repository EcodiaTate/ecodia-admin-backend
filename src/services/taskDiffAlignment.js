'use strict'

const STOPWORDS = new Set([
  'task','session','file','files','code','codebase','backend','frontend','path',
  'paths','add','fix','update','change','new','build','create','make','use',
  'with','from','into','onto','that','this','these','those','them','they',
  'their','then','than','also','still','only','just','like','each','every',
  'all','any','some','most','more','less','same','other','one','two','any',
  'what','when','which','where','how','why','who','whose','whom','here','there',
  'about','after','before','between','during','through','under','over','upon',
  'should','must','need','needed','needs','want','wants','have','has','had',
  'been','being','was','were','will','would','could','shall','may','might',
  'true','false','null','yes','no','ok','okay','self','you','your','i','we',
  'out','in','on','at','to','for','by','up','down','off','as','is','are','be',
  'and','or','but','not','if','so','it','its','the','an','a','of','do','does',
  'src','test','tests','spec','specs','lib','dist','node_modules','utils','util',
  'service','services','module','modules','config','configs',
  'pipeline','stage','stages','status','output','input','data','row','rows',
  'json','http','api','url','ref','id','uuid','object','array','string','number',
  'boolean','function','method','handler','helper','helpers','result','return',
  'throw','throws','error','errors','log','logs','logger','debug','info','warn',
  'ms','seconds','minutes','hours','days','week','weeks','month','months','year',
  'ecodiaos','factory','session','sessions','commit','commits','diff','diffs',
  'deploy','deployed','deploying','approve','approved','reject','rejected',
  'claude','cc','mcp','pattern','patterns','doctrine','docs','documentation',
])

function extractKeywords(text) {
  if (!text || typeof text !== 'string') return []
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []
  const kept = []
  const seen = new Set()
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    kept.push(t)
    if (kept.length >= 25) break
  }
  return kept
}

function extractPathTokens(paths) {
  if (!Array.isArray(paths)) return []
  const tokens = new Set()
  for (const p of paths) {
    if (typeof p !== 'string') continue
    const parts = p.toLowerCase().split(/[\/\.\-_]+/).filter(Boolean)
    for (const part of parts) {
      if (part.length >= 3 && !STOPWORDS.has(part)) tokens.add(part)
    }
  }
  return Array.from(tokens)
}

function computeTaskDiffAlignment(statedTask, filesChanged) {
  const statedKeywords = extractKeywords(statedTask)
  const diffPathTokens = extractPathTokens(filesChanged)

  // Edge cases
  if (!Array.isArray(filesChanged) || filesChanged.length === 0) {
    return {
      flagged: true,
      overlapScore: 0,
      statedKeywords,
      diffPathTokens,
      reason: 'Empty files_changed - session produced no diff for the stated task.',
    }
  }
  if (statedKeywords.length < 3) {
    return {
      flagged: false,
      overlapScore: null,
      statedKeywords,
      diffPathTokens,
      reason: 'Stated task too generic to score (<3 meaningful keywords).',
    }
  }

  // Overlap: how many stated keywords appear as substrings of any diff path token
  let hits = 0
  const matched = []
  for (const kw of statedKeywords) {
    const hit = diffPathTokens.some((t) => t.includes(kw) || kw.includes(t))
    if (hit) { hits++; matched.push(kw) }
  }
  const overlapScore = hits / statedKeywords.length
  const flagged = overlapScore < 0.15

  return {
    flagged,
    overlapScore: Number(overlapScore.toFixed(3)),
    statedKeywords,
    diffPathTokens,
    matchedKeywords: matched,
    reason: flagged
      ? `Low keyword overlap (${(overlapScore * 100).toFixed(0)}%). Stated task keywords [${statedKeywords.slice(0, 8).join(', ')}] barely match diff paths [${diffPathTokens.slice(0, 8).join(', ')}].`
      : `Alignment OK (${(overlapScore * 100).toFixed(0)}% keyword overlap).`,
  }
}

module.exports = { computeTaskDiffAlignment }
