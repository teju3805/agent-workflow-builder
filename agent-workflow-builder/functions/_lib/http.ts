import type { Request, Response } from 'express';

/** Session variables Hasura attaches to every Action / Event payload. */
export function sessionUserId(req: Request): string | null {
  const sv = (req.body?.session_variables ?? {}) as Record<string, string>;
  const id = sv['x-hasura-user-id'];
  return id && id !== 'null' ? id : null;
}

export function sessionRole(req: Request): string {
  const sv = (req.body?.session_variables ?? {}) as Record<string, string>;
  return sv['x-hasura-role'] ?? 'public';
}

/**
 * Event Triggers and cron jobs are internal callers. Requiring a shared secret
 * stops anyone from POSTing a fake event straight at the function URL and
 * driving the engine on someone else's run.
 */
export function assertInternal(req: Request, res: Response): boolean {
  const expected = process.env.INTERNAL_WEBHOOK_SECRET;
  if (!expected) return true; // not configured locally
  if (req.headers['x-internal-secret'] !== expected) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  return true;
}

/** Hasura renders `message` to the client and swallows everything else. */
export function actionError(res: Response, status: number, message: string, code?: string) {
  return res.status(status).json({ message, extensions: { code: code ?? 'action-error' } });
}
