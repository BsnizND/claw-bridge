import { describe, expect, it } from 'vitest';
import { buildLifeOSNotificationPreview } from '../src/notification-preview.js';

describe('LifeOS notification previews', () => {
  it('keeps human-readable prose and removes the structured card payload', () => {
    expect(
      buildLifeOSNotificationPreview(
        'It will be partly cloudy and 83° today.\n' +
          '<lifeos_ui_composition>{"schema":"lifeos_ui_composition.v1","blocks":[]}</lifeos_ui_composition>'
      )
    ).toBe('It will be partly cloudy and 83° today.');
  });

  it('uses a neutral preview for a card-only reply', () => {
    expect(
      buildLifeOSNotificationPreview(
        '<lifeos_ui_composition>{"schema":"lifeos_ui_composition.v1","blocks":[]}</lifeos_ui_composition>'
      )
    ).toBe('Jay sent you an update.');
  });

  it('fails closed on unfinished and unwrapped structured output', () => {
    expect(
      buildLifeOSNotificationPreview(
        'Here is the forecast.\n<lifeos_ui_composition>{"schema":"lifeos_ui_composition.v1"'
      )
    ).toBe('Here is the forecast.');
    expect(
      buildLifeOSNotificationPreview(
        'Here is the forecast.\n```json\n{"schema":"lifeos_ui_composition.v1","blocks":[]}'
      )
    ).toBe('Here is the forecast.');
  });
});
