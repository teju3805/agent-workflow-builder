import { adminGql } from './gql';

export type RunContext = {
  runId: string;
  orgId: string;
  workflowId: string;
  /** run input — webhook payload, watched row, or manual input */
  input: Record<string, unknown>;
  /** outputs of completed steps, keyed by step name and by position */
  steps: Record<string, unknown>;
  prev: unknown;
};

/* ------------------------------------------------------------------ */
/* Templating: {{input.subject}} / {{prev.text}} / {{steps.Classify.text}} */
/* ------------------------------------------------------------------ */

function lookup(path: string, ctx: RunContext): unknown {
  const parts = path.split('.').filter(Boolean);
  let cur: any =
    parts[0] === 'input' ? ctx.input
      : parts[0] === 'prev' ? ctx.prev
      : parts[0] === 'steps' ? ctx.steps
      : undefined;
  for (const p of parts.slice(1)) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Replaces {{...}} placeholders anywhere inside a string / object / array. */
export function render<T>(value: T, ctx: RunContext): T {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (whole) return lookup(whole[1], ctx) as unknown as T; // keep the real type
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, path) => {
      const v = lookup(String(path), ctx);
      return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => render(v, ctx)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = render(v as unknown, ctx);
    return out as T;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* llm_call — real API, or a disclosed stub when no key is configured   */
/* ------------------------------------------------------------------ */

const LLM_URL = process.env.LLM_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const LLM_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.1-8b-instant';

export async function runLlmCall(config: any, ctx: RunContext) {
  const prompt = render(String(config.prompt ?? ''), ctx);
  const system = render(String(config.system ?? 'You are a concise workflow assistant.'), ctx);

  if (!LLM_KEY) {
    // Disclosed stub: same shape, artificial latency, flagged in the output so
    // nobody mistakes it for a real completion.
    await new Promise((r) => setTimeout(r, 900));
    const text = /urgent|refund|angry|outage|down/i.test(prompt)
      ? 'URGENT — this needs a human. Sentiment: negative.'
      : 'ROUTINE — can be handled automatically. Sentiment: neutral.';
    return { text, model: 'stub', stubbed: true, prompt_preview: prompt.slice(0, 200) };
  }

  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify({
      model: config.model || LLM_MODEL,
      temperature: config.temperature ?? 0.2,
      max_tokens: config.max_tokens ?? 300,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    // thrown -> the engine retries
    throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const json: any = await res.json();
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    model: json.model ?? config.model ?? LLM_MODEL,
    stubbed: false,
    usage: json.usage ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* http_request                                                         */
/* ------------------------------------------------------------------ */

export async function runHttpRequest(config: any, ctx: RunContext) {
  const url = render(String(config.url ?? ''), ctx);
  const method = String(config.method ?? 'GET').toUpperCase();
  const headers = render((config.headers ?? {}) as Record<string, string>, ctx);
  const body = config.body == null ? undefined : render(config.body, ctx);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.timeout_ms ?? 15000));

  try {
    const res = await fetch(url, {
      method,
      headers: method === 'GET' ? headers : { 'content-type': 'application/json', ...headers },
      body: method === 'GET' || body === undefined ? undefined
        : typeof body === 'string' ? body : JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await res.text();
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch { /* keep text */ }

    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return { status: res.status, ok: res.ok, body: parsed };
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ */
/* db_write — writes into our own tables, always org-scoped             */
/* ------------------------------------------------------------------ */

export async function runDbWrite(config: any, ctx: RunContext, stepRunId: string) {
  const key = render(String(config.key ?? 'result'), ctx);
  const value = render(config.value ?? { prev: '{{prev}}' }, ctx);

  const data = await adminGql<{ insert_step_outputs_one: { id: string } }>(
    `mutation Write($o: step_outputs_insert_input!) {
       insert_step_outputs_one(object: $o) { id }
     }`,
    {
      o: {
        org_id: ctx.orgId,           // never taken from config — always the run's org
        workflow_run_id: ctx.runId,
        step_run_id: stepRunId,
        key,
        value: value ?? {},
      },
    }
  );
  return { written: true, key, step_output_id: data.insert_step_outputs_one.id };
}

/* ------------------------------------------------------------------ */
/* notify — queued here, delivered by the notification_queued Event Trigger */
/* ------------------------------------------------------------------ */

export async function runNotify(config: any, ctx: RunContext, stepRunId: string) {
  const message = render(String(config.message ?? 'Workflow update'), ctx);
  const target = config.target ? render(String(config.target), ctx) : null;

  const data = await adminGql<{ insert_notifications_one: { id: string } }>(
    `mutation Notify($o: notifications_insert_input!) {
       insert_notifications_one(object: $o) { id }
     }`,
    {
      o: {
        org_id: ctx.orgId,
        workflow_run_id: ctx.runId,
        step_run_id: stepRunId,
        channel: config.channel ?? 'slack',
        target,
        message,
        status: 'queued',
      },
    }
  );
  return { queued: true, notification_id: data.insert_notifications_one.id };
}

/* ------------------------------------------------------------------ */
/* conditional_branch                                                   */
/* ------------------------------------------------------------------ */

export type BranchDecision = { matched: boolean; left: unknown; operator: string; right: unknown };

export function evaluateCondition(config: any, ctx: RunContext): BranchDecision {
  const left = render(config.left ?? '{{prev.text}}', ctx);
  const right = render(config.right ?? '', ctx);
  const operator = String(config.operator ?? 'contains');

  const l = left == null ? '' : typeof left === 'string' ? left : JSON.stringify(left);
  const r = right == null ? '' : typeof right === 'string' ? right : JSON.stringify(right);

  let matched: boolean;
  switch (operator) {
    case 'equals':        matched = l.trim().toLowerCase() === r.trim().toLowerCase(); break;
    case 'not_contains':  matched = !l.toLowerCase().includes(r.toLowerCase()); break;
    case 'gt':            matched = Number(l) > Number(r); break;
    case 'lt':            matched = Number(l) < Number(r); break;
    case 'matches':       matched = new RegExp(r, 'i').test(l); break;
    case 'contains':
    default:              matched = l.toLowerCase().includes(r.toLowerCase());
  }
  return { matched, left, operator, right };
}
