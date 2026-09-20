// Kaunta API — Cloudflare Worker router.

import { json, corsHeaders } from './util.js';
import { register, login, logout, requireAuth } from './auth.js';
import { syncHandler, opHandler } from './sync.js';
import { summaryHandler } from './summary.js';
import { payRequest, payCallback, payVerify, payInfo } from './billing.js';
import {
  adminStats, adminBars, adminRenew, adminStatus, adminPrice, adminPayments,
  adminAnnouncements, adminAnnounce, adminAnnounceDelete, publicAnnouncement,
} from './admin.js';

async function readBody(req) {
  try { return await req.json(); } catch (e) { return {}; }
}

function withCors(req, res) {
  const h = corsHeaders(req);
  for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
  return res;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const ctx = { req, env, DB: env.DB, body: {}, user: null, bar: null };
    const ok = (o, s = 200) => withCors(req, json(o, s));

    try {
      // Public routes
      if (url.pathname === '/api/register' && req.method === 'POST') {
        return withCors(req, await register(env, await readBody(req)));
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        return withCors(req, await login(env, await readBody(req)));
      }
      if (url.pathname === '/api/pay/callback' && req.method === 'POST') {
        return payCallback(env, await req.text());
      }
      if (url.pathname === '/api/announcements' && req.method === 'GET') {
        return withCors(req, await publicAnnouncement(env));
      }
      if (url.pathname === '/health') {
        return ok({ ok: true, ts: Date.now() });
      }

      // Everything else requires auth
      if (req.method === 'POST') ctx.body = await readBody(req);

      const authErr = await requireAuth(ctx);
      if (authErr) return withCors(req, authErr);

      const p = url.pathname;

      if (p === '/api/logout' && req.method === 'POST') {
        const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        return withCors(req, await logout(env, t));
      }
      if (p === '/api/me' && req.method === 'GET') {
        return ok({
          ok: true,
          user: ctx.user,
          bar: ctx.bar ? { id: ctx.bar.id, name: ctx.bar.name, slug: ctx.bar.slug, join_code: ctx.bar.join_code } : null,
        });
      }
      if (p === '/api/sync' && req.method === 'POST') {
        return withCors(req, await syncHandler(env, ctx, ctx.body));
      }
      if (p === '/api/op' && req.method === 'POST') {
        return withCors(req, await opHandler(env, ctx, ctx.body));
      }
      if (p === '/api/summary' && req.method === 'GET') {
        return withCors(req, await summaryHandler(env, ctx, url.searchParams));
      }
      if (p === '/api/pay/request' && req.method === 'POST') {
        return withCors(req, await payRequest(env, ctx));
      }
      if (p === '/api/pay/info' && req.method === 'GET') {
        return withCors(req, await payInfo(env, ctx));
      }
      if (p === '/api/pay/verify' && req.method === 'POST') {
        return withCors(req, await payVerify(env, ctx));
      }

      // Systems admin routes (guarded by role === 'admin' inside each handler)
      if (p === '/api/admin/stats' && req.method === 'GET') {
        return withCors(req, await adminStats(env, ctx));
      }
      if (p === '/api/admin/bars' && req.method === 'GET') {
        return withCors(req, await adminBars(env, ctx, url.searchParams));
      }
      if (p === '/api/admin/renew' && req.method === 'POST') {
        return withCors(req, await adminRenew(env, ctx));
      }
      if (p === '/api/admin/status' && req.method === 'POST') {
        return withCors(req, await adminStatus(env, ctx));
      }
      if (p === '/api/admin/price' && req.method === 'POST') {
        return withCors(req, await adminPrice(env, ctx));
      }
      if (p === '/api/admin/payments' && req.method === 'GET') {
        return withCors(req, await adminPayments(env, ctx, url.searchParams));
      }
      if (p === '/api/admin/announcements' && req.method === 'GET') {
        return withCors(req, await adminAnnouncements(env, ctx));
      }
      if (p === '/api/admin/announce' && req.method === 'POST') {
        return withCors(req, await adminAnnounce(env, ctx));
      }
      if (p === '/api/admin/announce/delete' && req.method === 'POST') {
        return withCors(req, await adminAnnounceDelete(env, ctx));
      }

      return ok({ error: 'Not found' }, 404);
    } catch (e) {
      return ok({ error: 'Server error: ' + e.message }, 500);
    }
  },
};