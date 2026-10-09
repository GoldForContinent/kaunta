// Owner-only audit trail: the most recent logged actions for this bar,
// each tagged with the actor (uid/uname) captured at write time.
import { json } from './util.js';

export async function auditLog({ DB }, ctx, q) {
  if (!ctx.user || ctx.user.role !== 'owner') return json({ error: 'Owner only' }, 403);
  const limit = Math.min(300, Math.max(1, Math.round(Number((q && q.get('limit')) || 120) || 120)));
  const rows = await DB.prepare(
    'SELECT seq, type, payload, uid, uname, created_at FROM changes WHERE bar_id = ? ORDER BY seq DESC LIMIT ?'
  ).bind(ctx.bar.id, limit).all();

  const items = (rows.results || []).map((r) => {
    let p = {};
    try { p = JSON.parse(r.payload || '{}'); } catch (e) {}
    return {
      seq: r.seq,
      type: r.type,
      uid: r.uid || p.uid || '',
      uname: r.uname || p.name || p.staff || p.who || '',
      t: r.created_at,
      payload: p,
    };
  });
  return json({ ok: true, items });
}
