// ============================================================
// Workflow library: ready-made, fully wired automation bundles for the
// jobs every WhatsApp business runs — capture the lead, answer prices,
// track orders, hand over to a human, chase payment, ask for feedback.
//
// Unlike the quick-start templates (which open the builder with blanks),
// a workflow is installed with its tags, pipeline and stage already
// resolved, so it can be switched on as-is. Installs are drafts
// (inactive) by default; the owner reviews the wording, then turns them on.
//
// Menu buttons chain into keyword workflows: Meta delivers a tapped
// button with its title as the message text, so "View prices" matches the
// price workflow's "price" keyword, and "Not happy" the hand-off one.
// ============================================================

import type { AutomationTriggerType } from '@/types'
import type { BuilderStepInput } from './steps-tree'

export type WorkflowKey =
  | 'lead_capture'
  | 'price_enquiry'
  | 'order_tracking'
  | 'human_handoff'
  | 'payment_reminder'
  | 'delivery_feedback'

/** Everything a workflow needs from the account, resolved at install time. */
export interface WorkflowResources {
  businessName: string
  /** tag name → tag id (created on install when missing). */
  tags: Record<string, string>
  /** "Lead to Settlement" pipeline and its stages by name. */
  pipelineId: string
  stages: Record<string, string>
}

export interface WorkflowAutomationDraft {
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  steps: BuilderStepInput[]
}

export interface WorkflowDefinition {
  key: WorkflowKey
  /** Tags created on install if the account does not have them. */
  tags: string[]
  /** Whether the "Lead to Settlement" pipeline must exist. */
  needsPipeline: boolean
  build: (r: WorkflowResources) => WorkflowAutomationDraft[]
}

export const SETTLEMENT_PIPELINE_NAME = 'Lead to Settlement'

export const WORKFLOW_TAGS = {
  newLead: 'New lead',
  priceEnquiry: 'Price enquiry',
  orderSupport: 'Order support',
  needsHuman: 'Needs human',
  paymentPending: 'Payment pending',
  delivered: 'Delivered',
  happyCustomer: 'Happy customer',
} as const

/** Button ids — stable, so other automations or flows can chain on them. */
export const WORKFLOW_BUTTONS = {
  prices: 'wf_prices',
  track: 'wf_track',
  team: 'wf_team',
  feedbackGood: 'wf_feedback_good',
  feedbackBad: 'wf_feedback_bad',
} as const

const tag = (r: WorkflowResources, name: string) => {
  const id = r.tags[name]
  if (!id) throw new Error(`workflow needs tag "${name}"`)
  return id
}

export const WORKFLOWS: WorkflowDefinition[] = [
  {
    key: 'lead_capture',
    tags: [WORKFLOW_TAGS.newLead],
    needsPipeline: true,
    build: (r) => [
      {
        name: 'Workflow · Welcome & lead capture',
        description: 'First message: greet with a menu, tag as New lead and open a deal in New enquiry.',
        trigger_type: 'first_inbound_message',
        trigger_config: {},
        steps: [
          {
            step_type: 'send_buttons',
            step_config: {
              kind: 'buttons',
              body: `Hi! 👋 Welcome to ${r.businessName}. How can we help you today?`,
              footer: 'Tap an option or just type your question',
              buttons: [
                { id: WORKFLOW_BUTTONS.prices, title: 'View prices' },
                { id: WORKFLOW_BUTTONS.track, title: 'Track my order' },
                { id: WORKFLOW_BUTTONS.team, title: 'Talk to our team' },
              ],
            },
          },
          { step_type: 'add_tag', step_config: { tag_id: tag(r, WORKFLOW_TAGS.newLead) } },
          {
            step_type: 'create_deal',
            step_config: {
              pipeline_id: r.pipelineId,
              stage_id: r.stages['New enquiry'],
              title: 'WhatsApp enquiry',
              value: 0,
            },
          },
        ],
      },
    ],
  },
  {
    key: 'price_enquiry',
    tags: [WORKFLOW_TAGS.priceEnquiry],
    needsPipeline: false,
    build: (r) => [
      {
        name: 'Workflow · Price & catalogue enquiry',
        description: 'Customer asks for prices: send the price list, tag Price enquiry, offer to order.',
        trigger_type: 'keyword_match',
        trigger_config: {
          keywords: ['price', 'prices', 'cost', 'rate', 'fees', 'how much', 'catalogue', 'catalog'],
          match_type: 'contains',
          case_sensitive: false,
        },
        steps: [
          {
            step_type: 'send_message',
            step_config: {
              text:
                `Here is our price list 📋\n\n• Product 1 — ₹___\n• Product 2 — ₹___\n• Combo offer — ₹___\n\n` +
                `Reply with the product name and quantity and we'll confirm your order. Free delivery on orders above ₹___.`,
            },
          },
          { step_type: 'add_tag', step_config: { tag_id: tag(r, WORKFLOW_TAGS.priceEnquiry) } },
        ],
      },
    ],
  },
  {
    key: 'order_tracking',
    tags: [WORKFLOW_TAGS.orderSupport],
    needsPipeline: false,
    build: (r) => [
      {
        name: 'Workflow · Order tracking',
        description: 'Customer asks about an order: ask for the order number and route the chat to the team.',
        trigger_type: 'keyword_match',
        trigger_config: {
          keywords: ['track', 'order status', 'where is my order', 'delivery', 'shipment', 'courier', 'not received'],
          match_type: 'contains',
          case_sensitive: false,
        },
        steps: [
          {
            step_type: 'send_message',
            step_config: {
              text: "Sure, let me check that for you 📦 Please send your order number (or the phone number used for the order) and we'll share the latest status.",
            },
          },
          { step_type: 'add_tag', step_config: { tag_id: tag(r, WORKFLOW_TAGS.orderSupport) } },
          { step_type: 'assign_conversation', step_config: { mode: 'round_robin' } },
        ],
      },
    ],
  },
  {
    key: 'human_handoff',
    tags: [WORKFLOW_TAGS.needsHuman],
    needsPipeline: false,
    build: (r) => [
      {
        name: 'Workflow · Human hand-off & complaints',
        description: 'Customer wants a person or is unhappy: apologise, tag Needs human and assign a teammate.',
        trigger_type: 'keyword_match',
        trigger_config: {
          keywords: ['talk to', 'agent', 'human', 'call me', 'complaint', 'refund', 'not happy', 'damaged', 'wrong item'],
          match_type: 'contains',
          case_sensitive: false,
        },
        steps: [
          {
            step_type: 'send_message',
            step_config: {
              text: "Thanks for telling us 🙏 A member of our team will reply personally in a few minutes. If it's about an order, please share the order number and a photo if anything is damaged.",
            },
          },
          { step_type: 'add_tag', step_config: { tag_id: tag(r, WORKFLOW_TAGS.needsHuman) } },
          { step_type: 'assign_conversation', step_config: { mode: 'round_robin' } },
        ],
      },
    ],
  },
  {
    key: 'payment_reminder',
    tags: [WORKFLOW_TAGS.paymentPending],
    needsPipeline: false,
    build: (r) => [
      {
        name: 'Workflow · Payment reminder',
        description: 'Tag a contact Payment pending: send payment details, remind after 3 hours if still unpaid.',
        trigger_type: 'tag_added',
        trigger_config: { tag_id: tag(r, WORKFLOW_TAGS.paymentPending) },
        steps: [
          {
            step_type: 'send_message',
            step_config: {
              text:
                `Your order is confirmed ✅ Please complete the payment to ship it:\n\nUPI: ___@___\nAmount: ₹___\n\n` +
                `Send a screenshot here once paid. Thank you for choosing ${r.businessName}!`,
            },
          },
          { step_type: 'wait', step_config: { amount: 3, unit: 'hours' } },
          {
            // Remove the Payment pending tag when the money arrives and
            // the reminder is skipped.
            step_type: 'condition',
            step_config: { subject: 'tag_presence', operand: tag(r, WORKFLOW_TAGS.paymentPending) },
            branches: {
              yes: [
                {
                  step_type: 'send_message',
                  step_config: {
                    text: 'Gentle reminder 🙂 your order is waiting for payment. Reply here if you need the details again or another payment option.',
                  },
                },
              ],
              no: [],
            },
          },
        ],
      },
    ],
  },
  {
    key: 'delivery_feedback',
    tags: [WORKFLOW_TAGS.delivered, WORKFLOW_TAGS.happyCustomer],
    needsPipeline: false,
    build: (r) => [
      {
        name: 'Workflow · Delivery feedback (ask)',
        description: 'Tag a contact Delivered: two hours later ask how the order was, with quick buttons.',
        trigger_type: 'tag_added',
        trigger_config: { tag_id: tag(r, WORKFLOW_TAGS.delivered) },
        steps: [
          { step_type: 'wait', step_config: { amount: 2, unit: 'hours' } },
          {
            step_type: 'send_buttons',
            step_config: {
              kind: 'buttons',
              body: `Your order from ${r.businessName} has been delivered 🎉 How was your experience?`,
              buttons: [
                { id: WORKFLOW_BUTTONS.feedbackGood, title: 'Loved it ⭐' },
                // "Not happy" is also a hand-off keyword, so the complaint
                // workflow picks it up and assigns a teammate.
                { id: WORKFLOW_BUTTONS.feedbackBad, title: 'Not happy' },
              ],
            },
          },
        ],
      },
      {
        name: 'Workflow · Delivery feedback (thank you)',
        description: 'Customer tapped "Loved it": thank them, ask for a review and tag Happy customer.',
        trigger_type: 'interactive_reply',
        trigger_config: { reply_ids: [WORKFLOW_BUTTONS.feedbackGood] },
        steps: [
          {
            step_type: 'send_message',
            step_config: {
              text: 'Thank you so much! 💚 Would you leave us a quick review? It really helps: https://___\n\nAs a thank-you, use code THANKS10 for 10% off your next order.',
            },
          },
          { step_type: 'add_tag', step_config: { tag_id: tag(r, WORKFLOW_TAGS.happyCustomer) } },
        ],
      },
    ],
  },
]

export function getWorkflow(key: string): WorkflowDefinition | null {
  return WORKFLOWS.find((w) => w.key === key) ?? null
}
