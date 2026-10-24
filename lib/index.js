// dsh-wechat-send：让 agent 主动向微信会话（群/私聊）发送表情包。
// 两个模型工具：
//   wechat_sticker_pool   —— 列某会话可用的微信原生表情池（id + 描述 + 标签）
//   wechat_send_sticker   —— 从池里挑一张，经 WeChatAgent 桥接受控端点发出
// 共享表情池收集（绕过 WeChatAgent 的自动收集）：
//   桥接在收到白名单会话的贴纸图时 POST 本插件的 127.0.0.1:11232/collect，
//   本插件从 reader 拉图字节，再经 reader 的 /api/v1/stickers/import 导入共享池
//   （reader 侧负责：白名单校验、GIF 归一、满池时自动触发 DS 评选保留 50 张、标签保存）。
// 发送不绕过任何既有闸门：桥接侧会再校验白名单、表情开关、发送限额，
// 并走 MediaOutbox 持久队列做送达确认。
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-wechat-send'
export const inject = ['tools']

const KEY_RE = /^wechat:(group|private):\d{1,64}$/
const STICKER_RE = /^[a-f0-9]{64}$/

// ── 配置防篡改：关键项内置安全基线，外部改动会在插件启动时自动纠正 ──────────
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PATCH_FILE = path.join(PLUGIN_DIR, 'cordis.patch.yml')
const CONFIG_BASELINE = {
  bridgeUrl: 'http://127.0.0.1:11231',
  tokenFile: 'D:/WeChatAgent/data/workspace/state/social-dsh-token.txt',
  timeoutMs: 15000,
  readerUrl: 'http://127.0.0.1:5031',
  readerTokenFile: 'D:/WeChatAgent/data/workspace/state/wechat-io-config.json',
  collectPort: 11232,
  allowedKeys: ['wechat:group:2033139186', 'wechat:private:417674264']
}
const BASELINE_PATCH_TEXT = `# dsh-wechat-send —— DSH bundle patch（基线版，关键配置受插件内置防护，请勿直接修改）
# 挂进 profile 配置树（bundle 层）。安装：link 依赖 + node_modules junction + bundles 条目。
- insert:
    - id: dsh-wechat-send
      name: dsh-wechat-send
      config:
        # WeChatAgent 桥接的受控发送端点（social-bridge.js 里 127.0.0.1:11231）
        bridgeUrl: "http://127.0.0.1:11231"
        # 与 DSH 侧插件共用的桥接鉴权 token 文件
        tokenFile: "D:/WeChatAgent/data/workspace/state/social-dsh-token.txt"
        timeoutMs: 15000
        # 表情池收集：reader 服务（拉图 + 导入共享池）与收集监听端口
        readerUrl: "http://127.0.0.1:5031"
        readerTokenFile: "D:/WeChatAgent/data/workspace/state/wechat-io-config.json"
        collectPort: 11232
        # 只允许向这些会话发送与收集（空数组 = 不额外限制，桥接白名单仍生效）
        allowedKeys:
          - "wechat:group:2033139186"
          - "wechat:private:417674264"
`
function guardPatchFile() {
  try {
    const text = fs.readFileSync(PATCH_FILE, 'utf8')
    const checks = [
      'bridgeUrl: "http://127.0.0.1:11231"',
      'tokenFile: "D:/WeChatAgent/data/workspace/state/social-dsh-token.txt"',
      'collectPort: 11232',
      '- "wechat:group:2033139186"',
      '- "wechat:private:417674264"'
    ]
    const missing = checks.filter((c) => !text.includes(c))
    if (!missing.length) return false
    console.log(`[dsh-wechat-send] 检测到 cordis.patch.yml 被修改（缺失 ${missing.length} 项关键配置），自动恢复基线。`)
    const bak = PATCH_FILE + '.tampered.bak'
    if (!fs.existsSync(bak)) fs.copyFileSync(PATCH_FILE, bak)
    fs.writeFileSync(PATCH_FILE, BASELINE_PATCH_TEXT, 'utf8')
    return true
  } catch { return false }
}

export function apply(ctx, config = {}) {
  guardPatchFile()
  // 运行时以基线为准：外部配置可增（白名单并集、显式覆盖），但基线条目不可被移除。
  const effective = {
    ...CONFIG_BASELINE,
    ...(typeof config === 'object' && config ? config : {}),
    allowedKeys: [...new Set([...(Array.isArray(config?.allowedKeys) ? config.allowedKeys.map(String) : []), ...CONFIG_BASELINE.allowedKeys])]
  }
  const bridgeUrl = String(effective.bridgeUrl ?? 'http://127.0.0.1:11231').replace(/\/+$/, '')
  const tokenFile = String(effective.tokenFile ?? 'D:/WeChatAgent/data/workspace/state/social-dsh-token.txt')
  const timeoutMs = Number(effective.timeoutMs ?? 15000)
  const allowedKeys = new Set((Array.isArray(effective.allowedKeys) ? effective.allowedKeys : []).map(String))
  const readerUrl = String(effective.readerUrl ?? 'http://127.0.0.1:5031').replace(/\/+$/, '')
  const readerTokenFile = String(effective.readerTokenFile ?? 'D:/WeChatAgent/data/workspace/state/wechat-io-config.json')
  const collectPort = Number(effective.collectPort ?? 11232)

  const token = () => fs.readFileSync(tokenFile, 'utf8').trim()
  const readerToken = () => {
    try { return JSON.parse(fs.readFileSync(readerTokenFile, 'utf8').replace(/^\uFEFF/, '')).reader_token ?? '' } catch { return '' }
  }
  const guarded = (conversationKey) => {
    if (!KEY_RE.test(String(conversationKey ?? ''))) throw new Error('conversationKey 必须是 wechat:group:群号 或 wechat:private:微信号')
    if (allowedKeys.size && !allowedKeys.has(String(conversationKey))) throw new Error(`该会话不在本插件允许列表：${conversationKey}`)
  }

  // ── 共享表情池收集端点（桥接只通知，收集/导入由本插件驱动）─────────────────
  const collected = new Map()
  let collecting = false
  const collectQueue = []
  const collectServer = http.createServer((req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
    const addr = String(req.socket?.remoteAddress ?? '')
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return reply(403, { ok: false, error: 'LOOPBACK_ONLY' })
    if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/collect') return reply(404, { ok: false, error: 'NOT_FOUND' })
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return reply(400, { ok: false, error: 'BAD_JSON' }) }
      const key = String(body.conversationKey ?? '')
      const imageId = String(body.imageId ?? '')
      if (!KEY_RE.test(key) || !STICKER_RE.test(imageId)) return reply(400, { ok: false, error: 'INVALID_PAYLOAD' })
      if (allowedKeys.size && !allowedKeys.has(key)) return reply(403, { ok: false, error: 'CONVERSATION_NOT_ALLOWED' })
      const dedupe = `${key}\0${imageId}`
      if (collected.has(dedupe)) return reply(200, { ok: true, cached: true })
      collected.set(dedupe, Date.now())
      while (collected.size > 500) collected.delete(collected.keys().next().value)
      collectQueue.push({ key, imageId })
      if (!collecting) void drainCollect()
      return reply(200, { ok: true, queued: true })
    })
  })
  async function drainCollect() {
    collecting = true
    try {
      while (collectQueue.length) {
        const job = collectQueue.shift()
        try {
          await collectOne(job.key, job.imageId)
        } catch { /* 单张失败不阻塞队列 */ }
      }
    } finally { collecting = false }
  }
  async function collectOne(key, imageId) {
    const rtoken = readerToken()
    if (!rtoken) throw new Error('READER_TOKEN_MISSING')
    const headers = { authorization: `Bearer ${rtoken}` }
    const image = await fetch(`${readerUrl}/api/v1/images/${imageId}`, { headers, redirect: 'error', signal: AbortSignal.timeout(45000) })
    if (!image.ok) throw new Error(`READER_IMAGE_HTTP_${image.status}`)
    const content = await image.json().catch(() => ({}))
    if (typeof content.b64 !== 'string' || content.b64.length > 11200000) throw new Error('READER_IMAGE_INVALID')
    // 优先复用已有标签；没有则主动学习：调视觉模型给画面描述 + 标签。
    let labelFields = await existingLabel(headers, key, imageId)
    if (!labelFields) labelFields = await learnLabel(content.b64)
    const imported = await fetch(`${readerUrl}/api/v1/stickers/import`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ conversationKey: key, b64: content.b64, ...labelFields }),
      signal: AbortSignal.timeout(45000)
    })
    const result = await imported.json().catch(() => ({}))
    if (!imported.ok || result.ready !== true) throw new Error(`IMPORT_FAILED_${imported.status}`)
    return result
  }
  async function existingLabel(headers, key, imageId) {
    try {
      const lr = await fetch(`${readerUrl}/api/v1/stickers/labels`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'read', ids: [imageId], conversationKey: key }),
        signal: AbortSignal.timeout(10000)
      })
      const lj = await lr.json().catch(() => ({}))
      const label = Array.isArray(lj.labels) ? (lj.labels.find((l) => l && l.id === imageId) ?? lj.labels[0]) : null
      if (label && typeof label.description === 'string' && label.description.trim()) {
        return {
          description: label.description.trim().slice(0, 120),
          tags: (Array.isArray(label.tags) ? label.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 6) : [])
        }
      }
    } catch { /* 查询失败走主动学习 */ }
    return null
  }
  // 主动学习：调视觉模型（GLM-4V-Flash，与 dsh-wechat-emoji 同款）打画面描述 + 标签。
  const glmApiKey = () => {
    try {
      const k = JSON.parse(fs.readFileSync('C:/Users/i2773/.dsh/dsh-wechat-emoji-key.json', 'utf8')).apiKey
      if (typeof k === 'string' && k.trim()) return k.trim()
    } catch {}
    return process.env.ZHIPU_API_KEY ?? ''
  }
  async function learnLabel(b64) {
    const apiKey = glmApiKey()
    if (!apiKey) return {}
    try {
      const mime = b64.startsWith('/9j/') ? 'image/jpeg' : 'image/png'
      const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'glm-4v-flash',
          max_tokens: 256,
          temperature: 0.2,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
              { type: 'text', text: '描述这张表情包的画面与可见文字（≤120字），并给 2-6 个标签（情绪/用途/角色，每个≤16字）。只输出 JSON：{"description":"...","tags":["..."]}' }
            ]
          }]
        }),
        signal: AbortSignal.timeout(30000)
      })
      const j = await r.json().catch(() => ({}))
      const text = j?.choices?.[0]?.message?.content ?? ''
      const start = text.indexOf('{'); const end = text.lastIndexOf('}')
      if (start < 0 || end <= start) return {}
      const parsed = JSON.parse(text.slice(start, end + 1))
      const description = typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 120) : ''
      const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 16)).slice(0, 6) : []
      if (!description) return {}
      return { description, tags }
    } catch { return {} }
  }
  collectServer.listen(collectPort, '127.0.0.1')
  collectServer.on('error', () => {})
  ctx.effect(() => () => collectServer.close())

  ctx.tools.register(defineTool({
    name: 'wechat_sticker_pool',
    description:
      '列出某个微信会话（群或私聊）当前可原生发送的表情包候选池。' +
      '返回每张的 id（64 位十六进制）、描述与标签；发送时把 id 传给 wechat_send_sticker。' +
      '仅列出桥接政策允许发送的会话；池为空时说明该会话还没有可复用的收藏表情。',
    parameters: {
      conversationKey: { type: 'string', description: '微信会话键，形如 wechat:group:2033139186 或 wechat:private:417674264' },
      query: { type: 'string', description: '可选：按关键词/描述过滤候选（最多 500 字）' }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? value?.error ?? '') }]
    },
    async execute(args) {
      try {
        guarded(args?.conversationKey)
        const qs = new URLSearchParams({ conversationKey: String(args.conversationKey) })
        if (typeof args?.query === 'string' && args.query.trim()) qs.set('query', args.query.slice(0, 500))
        const r = await fetch(`${bridgeUrl}/stickers?${qs}`, {
          headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(timeoutMs)
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok || !body.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
        const stickers = Array.isArray(body.stickers) ? body.stickers : []
        if (!stickers.length) {
          return { ok: true, message: `【${args.conversationKey}】当前没有可发送的表情候选。群里/私聊里多发几张表情，或先在桥接侧导入收藏，稍后再试。` }
        }
        const lines = stickers.slice(0, 20).map((s, i) => {
          const label = typeof s.description === 'string' && s.description.trim()
            ? s.description.trim().slice(0, 80)
            : '（无描述）'
          const tags = Array.isArray(s.tags) && s.tags.length ? `（${s.tags.map(String).join('、').slice(0, 80)}）` : ''
          return `${i + 1}) ${label}${tags}\n   id: ${s.id}`
        })
        return { ok: true, message: `【${args.conversationKey}】可发送表情 ${stickers.length} 张（最多列 20）：\n${lines.join('\n')}\n挑中哪张就把它的 id 交给 wechat_send_sticker。` }
      } catch (error) {
        return { ok: false, error: `表情池查询失败：${error?.message ?? error}`, message: `表情池查询失败：${error?.message ?? error}` }
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'wechat_send_sticker',
    description:
      '向指定微信会话（群或私聊）发送一张微信原生表情包。' +
      'id 必须来自 wechat_sticker_pool 列出的候选（64 位十六进制）；' +
      '这是真实对外发送动作：会真的发到微信里，桥接仍会校验白名单与发送限额，发送后走送达确认。' +
      '先 dry=true 预演，确认无误再 dry=false 真发。',
    parameters: {
      conversationKey: { type: 'string', description: '微信会话键，形如 wechat:group:2033139186 或 wechat:private:417674264' },
      stickerId: { type: 'string', description: '表情 id（64 位十六进制，来自 wechat_sticker_pool）' },
      dry: { type: 'boolean', description: 'true 只预演不发送；缺省为 false（真发）' }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? value?.error ?? '') }]
    },
    async execute(args) {
      try {
        guarded(args?.conversationKey)
        if (!STICKER_RE.test(String(args?.stickerId ?? ''))) throw new Error('stickerId 必须是 64 位十六进制（来自 wechat_sticker_pool）')
        const r = await fetch(`${bridgeUrl}/send-sticker`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
          body: JSON.stringify({ conversationKey: String(args.conversationKey), stickerId: String(args.stickerId), dry: args?.dry === true }),
          signal: AbortSignal.timeout(timeoutMs)
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok || !body.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
        if (body.dry === true) {
          return { ok: true, dry: true, message: `【预演通过，未发送】${body.plan.conversationKey} → sticker ${body.plan.stickerId}\n确认后把 dry 设为 false 真发。` }
        }
        return {
          ok: true,
          message: `【已发送入队】${args.conversationKey} → ${args.stickerId}\n投递号 ${body.deliveryId}；表情走桥接持久队列，送达状态可用 GET /send-status?deliveryId=… 核对（本工具暂不轮询）。`
        }
      } catch (error) {
        return { ok: false, error: `表情发送失败：${error?.message ?? error}`, message: `表情发送失败：${error?.message ?? error}` }
      }
    }
  }))
}
