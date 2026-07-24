import { describe, expect, it } from 'vitest';
import {
  buildLifeOSReplyNotificationPayload,
  deterministicNotificationUuid
} from '../src/apns.js';

describe('LifeOS APNs payloads', () => {
  it('binds the preview to one immutable versioned conversation route', () => {
    expect(
      buildLifeOSReplyNotificationPayload(
        'agent:jay:lifeos-home:thread-1',
        'A source-backed update.',
        'route-1',
        'assistant-message-42'
      )
    ).toEqual({
      aps: {
        alert: { title: 'Jay', body: 'A source-backed update.' },
        sound: 'default'
      },
      lifeos_route: {
        schema: 'lifeos_notification_route.v1',
        route_id: 'route-1',
        session_key: 'agent:jay:lifeos-home:thread-1',
        message_id: 'assistant-message-42'
      },
      session_key: 'agent:jay:lifeos-home:thread-1'
    });
  });

  it('uses a stable APNs UUID for the same conversation message', () => {
    const first = deterministicNotificationUuid(
      'agent:jay:lifeos-home:thread-1',
      'assistant-message-42'
    );
    const second = deterministicNotificationUuid(
      'agent:jay:lifeos-home:thread-1',
      'assistant-message-42'
    );
    const other = deterministicNotificationUuid(
      'agent:jay:lifeos-home:thread-1',
      'assistant-message-43'
    );

    expect(first).toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(other).not.toBe(first);
  });
});
