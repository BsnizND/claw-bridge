import { describe, expect, it } from 'vitest';
import { buildLifeOSReplyNotificationPayload } from '../src/apns.js';

describe('LifeOS APNs payloads', () => {
  it('binds the preview to one immutable versioned conversation route', () => {
    expect(
      buildLifeOSReplyNotificationPayload(
        'agent:jay:lifeos-home:thread-1',
        'A source-backed update.',
        'route-1'
      )
    ).toEqual({
      aps: {
        alert: { title: 'Jay', body: 'A source-backed update.' },
        sound: 'default'
      },
      lifeos_route: {
        schema: 'lifeos_notification_route.v1',
        route_id: 'route-1',
        session_key: 'agent:jay:lifeos-home:thread-1'
      },
      session_key: 'agent:jay:lifeos-home:thread-1'
    });
  });
});
