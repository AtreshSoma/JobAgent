import { describe, it, expect, vi } from 'vitest';
import { createNotifier } from '../../src/utils/notifier.js';

describe('notifier', () => {
  it('delivers events to a custom sink and records history', async () => {
    const sink = vi.fn();
    const notifier = createNotifier({ sink, now: () => '2026-06-04T00:00:00Z' });

    await notifier.info('Run started', 'DRY_RUN');
    await notifier.actionRequired('Approval needed', 'Job 123', { jobId: '123' });

    expect(sink).toHaveBeenCalledTimes(2);
    const history = notifier.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ level: 'info', title: 'Run started', at: '2026-06-04T00:00:00Z' });
    expect(history[1].level).toBe('action_required');
  });

  it('redacts secrets in notification meta', async () => {
    const sink = vi.fn();
    const notifier = createNotifier({ sink });
    await notifier.error('Login failed', 'dice', { user: 'x', password: 'secret' });
    const event = sink.mock.calls[0][0];
    expect(event.meta.user).toBe('x');
    expect(event.meta.password).toBe('[REDACTED]');
  });
});
