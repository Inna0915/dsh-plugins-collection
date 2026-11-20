/**
 * 闲庭 Vibe Reader 探针 · 宿主端。
 *
 * 只回答一个问题：插件能否在不进入任何会话的前提下，单次调用 ctx.llm
 * （无工具、不写会话日志），把结果交给侧栏面板。这是验证用原型，不是产品代码。
 *
 * - GET  api/vibe-reader-spike/ask  诊断：llm 是否可用、将使用的模型路由
 * - POST api/vibe-reader-spike/ask  试问书童：{ title, section, selection, intent }
 * - 环境变量 VIBE_READER_SPIKE_SELFTEST=<文件>：llm 可用后自动调用一次并写结果（供 headless 验证）
 * - 工具 vibe_reader_spike_check：仅在设置上述环境变量时注册，让 headless 回合等待自检结束，保证进程不提前退出
 */
import { writeFile } from 'node:fs/promises'

export const name = 'vibe-reader-spike'
export const inject = []

const API_PATH = '/api/vibe-reader-spike/ask'
const MAX_BODY = 8000
const SYSTEM = '你是用户的「私塾书童」。用户在编程间隙精读古文。请用精炼、通透、略带雅趣的中文回答，严格控制在 100 字以内。'

export const SAMPLE = Object.freeze({
  title: '岳阳楼记',
  section: '庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴。乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上，属予作文以记之。',
  selection: '百废具兴',
  intent: '字词训诂'
})

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function buildPrompt(input) {
  const title = clip(input.title, 60) || SAMPLE.title
  const section = clip(input.section, 1200) || SAMPLE.section
  const selection = clip(input.selection, 200) || SAMPLE.selection
  const intent = clip(input.intent, 20) || SAMPLE.intent
  return `我正在读《${title}》的这一节：「${section}」\n我划选了「${selection}」，想了解【${intent}】。`
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Plugin config wins; otherwise fall back to the profile's default model for new agents. */
export function resolveRoute(config, agentDefaultModel) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model, source: 'config' }
  const selection = agentDefaultModel?.currentSelection?.()
  if (selection?.provider && selection?.model) {
    return { provider: selection.provider, model: selection.model, source: 'agent-default-model' }
  }
  return null
}

/**
 * One isolated model call: request-only user input, no tools, no session id,
 * least reasoning effort the model declares, bounded output and wall time.
 */
export async function askOnce(llm, route, input, { timeoutMs = 45_000, maxTokens = 400 } = {}) {
  const started = Date.now()
  const signal = AbortSignal.timeout(timeoutMs)
  const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens }, signal, (controls, model) => {
    const least = model.reasoning?.efforts?.[0]?.id
    return least === undefined ? controls : { ...controls, reasoningEffort: least }
  })
  const options = {
    ...call.config,
    system: SYSTEM,
    messages: deepFreeze([{ role: 'user', content: [{ type: 'text', text: buildPrompt(input) }] }]),
    signal
  }
  let text = ''
  let usage
  let finish
  let firstTokenMs
  for await (const chunk of call.stream(options)) {
    if (chunk.type === 'text-delta') {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - started
      text += chunk.text
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  return {
    ok: finish?.kind === 'stop' || finish?.kind === 'max-tokens',
    text: text.trim(),
    finish: finish?.kind ?? 'missing',
    ...(finish?.failure ? { failure: { code: finish.failure.code, message: finish.failure.message } } : {}),
    route: {
      provider: call.config.provider,
      model: call.config.model,
      source: route.source,
      ...(call.config.reasoningEffort === undefined ? {} : { reasoningEffort: call.config.reasoningEffort }),
      maxTokens: call.config.maxTokens
    },
    firstTokenMs,
    totalMs: Date.now() - started,
    ...(usage ? { usage } : {})
  }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function describeError(error) {
  return { code: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 400) }
}

export function apply(ctx, rawConfig) {
  const config = {
    provider: clip(rawConfig?.provider, 120),
    model: clip(rawConfig?.model, 200)
  }
  const state = { llm: null, agentDefaultModel: null, selfTest: null }

  async function ask(input) {
    if (!state.llm) return { ok: false, failure: { code: 'NO_LLM_SERVICE', message: '宿主未向插件提供 llm 服务' } }
    const route = resolveRoute(config, state.agentDefaultModel)
    if (!route) return { ok: false, failure: { code: 'NO_ROUTE', message: '未配置 provider/model，且没有 agentDefaultModel 可回退' } }
    try {
      return await askOnce(state.llm, route, input)
    } catch (error) {
      return { ok: false, failure: describeError(error), route }
    }
  }

  function diagnostics() {
    let providers
    try { providers = state.llm?.listProviders?.() } catch (error) { providers = { error: describeError(error) } }
    return {
      llm: Boolean(state.llm),
      agentDefaultModel: Boolean(state.agentDefaultModel),
      route: resolveRoute(config, state.agentDefaultModel),
      providers
    }
  }

  function startSelfTest() {
    const target = process.env.VIBE_READER_SPIKE_SELFTEST
    if (!target || state.selfTest) return
    state.selfTest = (async () => {
      const result = { at: new Date().toISOString(), diagnostics: diagnostics(), result: await ask(SAMPLE) }
      await writeFile(target, JSON.stringify(result, null, 2) + '\n', 'utf8')
      return result
    })().catch((error) => ({ ok: false, failure: describeError(error) }))
  }

  ctx.inject?.(['agentDefaultModel'], (modelCtx) => {
    modelCtx.effect(() => {
      state.agentDefaultModel = modelCtx.agentDefaultModel
      return () => { if (state.agentDefaultModel === modelCtx.agentDefaultModel) state.agentDefaultModel = null }
    }, 'vibe-reader-spike: default model')
  })

  ctx.inject?.(['llm'], (llmCtx) => {
    llmCtx.effect(() => {
      state.llm = llmCtx.llm
      // Let agentDefaultModel attach first when both mount in the same tick.
      const timer = setTimeout(startSelfTest, 0)
      return () => {
        clearTimeout(timer)
        if (state.llm === llmCtx.llm) state.llm = null
      }
    }, 'vibe-reader-spike: llm')
  })

  ctx.inject?.(['connection'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.connection.fetch.register({
      path: API_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method === 'GET') return json(diagnostics())
        const body = await request.text()
        if (body.length > MAX_BODY) return json({ ok: false, failure: { code: 'TOO_LARGE', message: '请求过大' } }, 413)
        let input
        try { input = JSON.parse(body || '{}') } catch { return json({ ok: false, failure: { code: 'BAD_JSON', message: '请求格式无效' } }, 400) }
        return json(await ask(input && typeof input === 'object' ? input : {}))
      }
    }), 'vibe-reader-spike: http')
  })

  // Only the headless self-test needs a tool; never add it to everyday coding sessions.
  if (!process.env.VIBE_READER_SPIKE_SELFTEST) return
  ctx.inject?.(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: 'vibe_reader_spike_check',
      description: '闲庭探针自检：返回插件后端单次调用 ctx.llm 的结果（只读，无副作用）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
      },
      async execute() {
        startSelfTest()
        return state.selfTest ? await state.selfTest : { diagnostics: diagnostics(), result: await ask(SAMPLE) }
      }
    })
  })
}
