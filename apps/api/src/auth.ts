import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthStatusResponse, AuthUser } from '@pi-workbench/contracts';
import type { AppConfig } from './config.js';

const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const FEISHU_USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const STATE_TTL_MS = 10 * 60 * 1000;

type PendingState = { createdAt: number };

type FeishuSession = {
  user: AuthUser;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt: number;
  expiresAt: number;
};

type FeishuTokenResponse = {
  code?: number;
  msg?: string;
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type FeishuUserInfoResponse = {
  code?: number;
  msg?: string;
  data?: {
    name?: string;
    en_name?: string;
    avatar_url?: string;
    open_id?: string;
    union_id?: string;
    user_id?: string;
  };
};

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [];
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) return [];
    try {
      return [[key, decodeURIComponent(value)]];
    } catch {
      return [[key, value]];
    }
  }));
}

function serializeCookie(name: string, value: string, options: { maxAge: number; secure: boolean }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`, 'HttpOnly', 'SameSite=Lax'];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function redirectWithError(origin: string, error: string) {
  const url = new URL(origin);
  url.searchParams.set('auth_error', error);
  return url.toString();
}

function safeErrorMessage(payload: { msg?: string; error_description?: string; error?: string }) {
  return payload.msg ?? payload.error_description ?? payload.error ?? '飞书授权请求失败';
}

export function createFeishuAuth(config: AppConfig) {
  const sessions = new Map<string, FeishuSession>();
  const pendingStates = new Map<string, PendingState>();
  const cookieName = config.AUTH_COOKIE_NAME ?? 'pi_workbench_auth';
  const stateCookieName = `${cookieName}_state`;
  const sessionTtlSeconds = config.AUTH_SESSION_TTL_SECONDS ?? 7 * 24 * 60 * 60;
  const secureCookie = config.AUTH_COOKIE_SECURE ?? process.env.NODE_ENV === 'production';
  const redirectUri = config.FEISHU_REDIRECT_URI ?? `${config.WEB_ORIGIN.replace(/\/$/, '')}/api/v1/auth/feishu/callback`;
  const configured = Boolean(config.FEISHU_APP_ID && config.FEISHU_APP_SECRET);

  const status = async (request: FastifyRequest): Promise<AuthStatusResponse> => {
    const session = await getSession(request);
    return {
      provider: 'feishu',
      configured,
      authRequired: config.AUTH_REQUIRED,
      authenticated: Boolean(session),
      ...(session ? { user: session.user } : {}),
      ...(!configured ? { message: '请先在 API 环境变量中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。' } : {}),
    };
  };

  function setAuthCookie(reply: FastifyReply, sessionId: string) {
    reply.header('Set-Cookie', serializeCookie(cookieName, sessionId, { maxAge: sessionTtlSeconds, secure: secureCookie }));
  }

  function clearCookies(reply: FastifyReply) {
    reply.header('Set-Cookie', [
      serializeCookie(cookieName, '', { maxAge: 0, secure: secureCookie }),
      serializeCookie(stateCookieName, '', { maxAge: 0, secure: secureCookie }),
    ]);
  }

  function setStateCookie(reply: FastifyReply, state: string) {
    reply.header('Set-Cookie', serializeCookie(stateCookieName, state, { maxAge: 600, secure: secureCookie }));
  }

  function getSessionId(request: FastifyRequest) {
    return parseCookies(request.headers.cookie)[cookieName];
  }

  async function exchangeToken(body: Record<string, string>): Promise<FeishuTokenResponse> {
    if (!configured) throw new Error('飞书应用尚未配置');
    const response = await fetch(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ client_id: config.FEISHU_APP_ID, client_secret: config.FEISHU_APP_SECRET, ...body }),
    });
    const payload = await response.json() as FeishuTokenResponse;
    if (!response.ok || payload.code !== 0 || !payload.access_token) throw new Error(safeErrorMessage(payload));
    return payload;
  }

  async function getSession(request: FastifyRequest): Promise<FeishuSession | null> {
    const sessionId = getSessionId(request);
    if (!sessionId) return null;
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(sessionId);
      return null;
    }
    if (session.refreshToken && session.tokenExpiresAt <= Date.now() + 30_000) {
      try {
        const refreshed = await exchangeToken({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
        session.accessToken = refreshed.access_token!;
        session.refreshToken = refreshed.refresh_token ?? session.refreshToken;
        session.tokenExpiresAt = Date.now() + (refreshed.expires_in ?? 7200) * 1000;
      } catch {
        sessions.delete(sessionId);
        return null;
      }
    }
    return session;
  }

  function start(reply: FastifyReply) {
    if (!configured) return false;
    const state = randomBytes(32).toString('base64url');
    pendingStates.set(state, { createdAt: Date.now() });
    for (const [pendingState, value] of pendingStates) if (Date.now() - value.createdAt > STATE_TTL_MS) pendingStates.delete(pendingState);
    const url = new URL(FEISHU_AUTHORIZE_URL);
    url.searchParams.set('client_id', config.FEISHU_APP_ID!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    if (config.FEISHU_SCOPE) url.searchParams.set('scope', config.FEISHU_SCOPE);
    setStateCookie(reply, state);
    reply.redirect(url.toString());
    return true;
  }

  function verifyState(request: FastifyRequest, state: string | undefined) {
    if (!state) return false;
    const cookieState = parseCookies(request.headers.cookie)[stateCookieName];
    const pending = pendingStates.get(state);
    pendingStates.delete(state);
    return Boolean(cookieState && cookieState === state && pending && Date.now() - pending.createdAt <= STATE_TTL_MS);
  }

  async function complete(request: FastifyRequest, reply: FastifyReply, code: string, state: string | undefined) {
    if (!verifyState(request, state)) throw new Error('飞书登录状态校验失败，请重新发起登录');
    const token = await exchangeToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const userResponse = await fetch(FEISHU_USER_INFO_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
    const userPayload = await userResponse.json() as FeishuUserInfoResponse;
    if (!userResponse.ok || userPayload.code !== 0 || !userPayload.data) throw new Error(safeErrorMessage(userPayload));
    const user = userPayload.data;
    const sessionId = randomBytes(32).toString('base64url');
    sessions.set(sessionId, {
      user: { id: user.open_id ?? user.union_id ?? user.user_id ?? sessionId, name: user.name ?? user.en_name ?? '飞书用户', avatarUrl: user.avatar_url, openId: user.open_id },
      accessToken: token.access_token!,
      refreshToken: token.refresh_token,
      tokenExpiresAt: Date.now() + (token.expires_in ?? 7200) * 1000,
      expiresAt: Date.now() + sessionTtlSeconds * 1000,
    });
    setAuthCookie(reply, sessionId);
    return sessionId;
  }

  async function logout(request: FastifyRequest, reply: FastifyReply) {
    const sessionId = getSessionId(request);
    if (sessionId) sessions.delete(sessionId);
    clearCookies(reply);
    reply.code(204).send();
  }

  return { configured, redirectUri, status, start, complete, logout, getSession, clearCookies, redirectWithError: (error: string) => redirectWithError(config.WEB_ORIGIN, error) };
}
