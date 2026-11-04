import type { InstagramAutomationConfig, InstagramAutomationKind } from './rules'

// The five basics every Instagram DM tool ships (and buyers compare on).
// Seeded as drafts the first time the Instagram tab opens.
export const DEFAULT_INSTAGRAM_AUTOMATIONS: { kind: InstagramAutomationKind; name: string; priority: number; config: InstagramAutomationConfig }[] = [
  {
    kind: 'comment_to_dm',
    name: 'Comment "PRICE" → send details by DM',
    priority: 10,
    config: {
      keywords: ['price', 'details', 'info', 'link'],
      match: 'contains',
      reply_text: 'Hi {{name}}! 👋 Thanks for your comment. Here are the details you asked for: … Reply here and we will help you order.',
      public_reply: 'Sent you a DM {{name}} 📩',
    },
  },
  {
    kind: 'keyword',
    name: 'Keyword reply — price / order',
    priority: 20,
    config: {
      keywords: ['price', 'cost', 'how much', 'order', 'buy'],
      match: 'contains',
      reply_text: 'Happy to help! 😊 Our price list: … Tell us the product and quantity and we will confirm your order.',
    },
  },
  {
    kind: 'welcome',
    name: 'Welcome new DMs',
    priority: 30,
    config: { reply_text: 'Hi {{name}}, welcome! 🙌 How can we help you today? Ask about prices, orders or delivery.' },
  },
  {
    kind: 'story_mention',
    name: 'Thank story mentions',
    priority: 40,
    config: { reply_text: 'Thank you so much for the mention {{name}}! 💚 Here is 10% off your next order: THANKS10' },
  },
  {
    kind: 'away',
    name: 'Away message (after hours)',
    priority: 50,
    config: {
      days: [0, 1, 2, 3, 4, 5, 6],
      start_time: '21:00',
      end_time: '09:00',
      timezone: 'Asia/Kolkata',
      cooldown_minutes: 720,
      reply_text: 'Thanks for your message! We are offline now and will reply after 9 AM. 🌙',
    },
  },
]

export function defaultInstagramAutomations(accountId: string, userId: string) {
  return DEFAULT_INSTAGRAM_AUTOMATIONS.map((a) => ({ ...a, account_id: accountId, user_id: userId, is_active: false }))
}
