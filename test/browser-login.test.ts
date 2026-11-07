import { describe, expect, test } from 'bun:test';
import { browserLogin, clientName } from '../src/core/browser-login';
import { makeTheme } from '../src/ui/theme';

const theme = makeTheme(0, false);
const TOKEN = `bqat_${'a'.repeat(16)}_${'A'.repeat(43)}`;
const DEVICE = 'd'.repeat(43);

function fakeFetch(polls: any[]) {
  const calls: { url: string; body: any }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/auth/cli/start'))
      return Response.json({
        success: true,
        device_code: DEVICE,
        user_code: 'BCDF-GHJK',
        expires_in: 600,
        interval: 1,
      });
    return Response.json({ success: true, ...polls.shift() });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('browser login', () => {
  test('polls until approved and returns the token', async () => {
    const { impl, calls } = fakeFetch([
      { status: 'pending' },
      { status: 'approved', token: TOKEN, username: 'ada', expires_at: 1 },
    ]);
    const r = await browserLogin({
      theme,
      openBrowser: false,
      interactive: false,
      fetchImpl: impl,
    });
    expect(r).toEqual({ token: TOKEN, username: 'ada', expires_at: 1 });
    expect(calls[0].url).toBe('https://api.bitqate.com/auth/cli/start');
    expect(calls[0].body.client_name).toBe(clientName());
    expect(calls[1].body).toEqual({ device_code: DEVICE });
  }, 10_000);

  test('a denied request is reported as cancelled', async () => {
    const { impl } = fakeFetch([{ status: 'denied' }]);
    await expect(
      browserLogin({
        theme,
        openBrowser: false,
        interactive: false,
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  }, 10_000);

  test('an expired code asks to start over', async () => {
    const { impl } = fakeFetch([{ status: 'expired' }]);
    await expect(
      browserLogin({
        theme,
        openBrowser: false,
        interactive: false,
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  }, 10_000);
});
