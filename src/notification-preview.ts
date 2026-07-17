const CARD_ONLY_NOTIFICATION = 'Jay sent you an update.';
const LIFEOS_STRUCTURED_BLOCK_RE =
  /<(lifeos_[a-z0-9_]*composition)\b[^>]*>[\s\S]*?<\/\1>/gi;
const LIFEOS_STRUCTURED_TAIL_RE =
  /<(lifeos_[a-z0-9_]*composition)\b[^>]*>[\s\S]*$/i;
const LIFEOS_RAW_COMPOSITION_RE =
  /\{\s*"schema"\s*:\s*"lifeos_[a-z0-9_]*composition\.v\d+"[\s\S]*$/i;

export function buildLifeOSNotificationPreview(replyText: string): string {
  const proseOnly = replyText
    .replace(LIFEOS_STRUCTURED_BLOCK_RE, ' ')
    .replace(LIFEOS_STRUCTURED_TAIL_RE, ' ')
    .replace(LIFEOS_RAW_COMPOSITION_RE, ' ')
    .replace(/```(?:json)?\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return proseOnly || CARD_ONLY_NOTIFICATION;
}
