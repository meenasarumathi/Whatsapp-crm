# CRM work list

Everything the CRM does, grouped by area. **New** marks work added on 2026-10-10. All paths are under `wacrm-main/`.

## 1. Automation

Rules that run on their own: "when this happens, do that".

| Work | What it does | Where |
| --- | --- | --- |
| Triggers | New message, first message from a contact, keyword match, new contact, conversation assigned, tag added, time-based, button / list reply | Automations tab |
| Actions | Send message, buttons, list or template; add / remove tag; assign conversation; update contact field; create deal; wait; condition; send webhook; close conversation | Automations → builder |
| Ready-made templates | Welcome message, out-of-office, lead qualifier, follow-up reminder | Automations → New |
| Logs | Every run with its result | Automations → Logs |
| Broadcast follow-up funnel (concept) | Reminder for non-readers → follow-up for non-repliers → AI answers → hot-lead handling | Demo tab (showcase) — **New** |

Code: `src/lib/automations/`, `src/components/automations/`, `src/app/api/automations/`

## 2. Chatbot (Flows)

Button-and-menu chatbots that guide a customer step by step.

| Work | What it does | Where |
| --- | --- | --- |
| Flow builder | Drag-and-drop canvas and list view | Flows tab |
| Steps (nodes) | Send message, buttons, list, media; collect input; condition; set tag; hand off to a human; end | Flow editor |
| Triggers | Keyword, first inbound message, manual | Flow editor |
| Templates | Welcome menu, FAQ bot, lead capture | Flows → New |
| Fallback policy | Re-ask, hand off, or end when the reply doesn't match | Flow settings |
| Runs history | Every conversation that went through the flow | Flows → Runs |
| **Test flow (free sandbox)** | Chat with the flow in the browser; nothing is sent to WhatsApp, so there's no charge | Flow editor → Test flow — **New** |

Code: `src/lib/flows/` (`simulate.ts` and `pure.ts` are new), `src/components/flows/` (`flow-test-panel.tsx` is new)

## 3. AI agent

An AI assistant using your own OpenAI or Anthropic key.

| Work | What it does | Where |
| --- | --- | --- |
| Setup | Provider, model, key, instructions, master switch | AI Agents → Setup |
| Auto-reply 24/7 | Answers customers automatically, with a per-chat limit | AI Agents → Setup |
| Draft with AI | One-click reply drafts in the inbox | Inbox composer |
| Smart handoff | Hands complaints and hard questions to a human, with a summary | Automatic |
| Knowledge base | Answers from uploaded documents (semantic or keyword search) | AI Agents / Train AI → Documents |
| Playground | Test chat with the AI | AI Agents → Playground |
| Usage | Token spend per day | AI Agents → Usage |

Code: `src/lib/ai/`, `src/components/agents/`, `src/app/api/ai/`

## 4. AI training — **New**

A friendly page to teach the AI about the business. It's one of our two unique strengths.

| Work | What it does |
| --- | --- |
| AI readiness score | 0–100 score with a checklist of what to do next |
| Business profile | 11 plain questions: what you sell, tone, hours, pricing, policies, goals, when to hand over |
| Q&A answers | "Customer asks → we reply" pairs; import / export with Excel |
| Rules | Always / never instructions, with one-click suggestions |
| Learn from chats | Turn good inbox conversations into Q&A pairs |
| Documents, Test, What AI can do | Knowledge base, a safe test chat, and a status card for every AI feature |
| Used by the AI | Profile, rules and the closest Q&A pairs go into every draft, auto-reply and playground answer |

Where: sidebar → **Train AI** (between Inbox and Notifications). Database: `ai_training_profiles`, `ai_training_examples` (migration 044).
Code: `src/app/(dashboard)/train-ai/`, `src/components/train-ai/`, `src/lib/ai/training.ts`, `src/lib/ai/training-server.ts`

## 5. Workflow (how the pieces connect)

| Workflow | Steps |
| --- | --- |
| Broadcast → revenue funnel | Segment contacts → send template broadcast → follow up non-readers / non-repliers → AI answers replies → flow qualifies → tag "Hot lead" → deal in pipeline → salesperson notified |
| New lead from WhatsApp | Keyword trigger → chatbot menu → collect name / budget → tag → AI answers → hand off → deal |
| Daily inbox | Unread chats → assign → reply (quick replies, templates, AI draft) → close |
| CRM setup (admin, once) | Connect WhatsApp → sync templates → tags & fields → invite team → import contacts → pipeline |

Documented in `wacrm-main/Guide/12-workflows.md`.

## 6. Broadcasts

Bulk template messages with personalised fields, safe batching, retries, and a per-recipient delivered / read report. **New:** the interactive broadcast funnel walkthrough on the Demo page.

Code: `src/app/(dashboard)/broadcasts/`, `src/lib/whatsapp/broadcast-*.ts`

## 7. Inbox

| Work | What it does |
| --- | --- |
| Shared inbox | All WhatsApp chats, assignment, status, unread, 24-hour window |
| Composer | Text, media, voice notes, templates, quick replies, interactive messages, reactions, replies |
| Contact panel | Details, tags, notes, deals |
| **Data sheet tab** — **New** | Download a chat as Excel / CSV; upload a shared chat → save to notes or teach the AI |

Code: `src/components/inbox/` (`conversation-data-sheet.tsx` is new), `src/lib/inbox/conversation-sheet.ts`

## 8. Contacts, pipelines, dashboard, notifications

- **Contacts:** add, CSV import, tags, custom fields, notes, duplicate protection.
- **Pipelines:** drag-and-drop deal stages, values, multiple currencies, analytics.
- **Dashboard:** conversations, response times, pipeline, activity.
- **Notifications:** in-app and desktop alerts.

## 9. Team, roles and subscriptions

| Work | What it does |
| --- | --- |
| Account roles | Owner, Admin, Agent, Viewer; invite links |
| **Platform roles** — **New** | Super admin, Admin 1, Admin 2, Subscription user |
| **Free trials** — **New** | 1, 7 or 15 days; mark paid, end now, suspend; new sign-ups get 7 days automatically |
| **Tab access** — **New** | Checkboxes to choose which sidebar tabs each user sees; select one or many users at once |
| **Add user** — **New** | Create a login with a role, trial and tabs |

Where: Settings → Subscription users. Database: `platform_users` (migration 043).
Code: `src/lib/platform/`, `src/app/api/platform/`, `src/components/settings/subscription-users-panel.tsx`, `src/components/layout/access-guard.tsx`

## 10. Database backup — **New**

One-click backup that downloads as JSON or Excel. Owners and Admins back up their own account; the Super admin can back up every account. Secrets are redacted.

Where: Settings → Backup. Code: `src/app/api/backup/`, `src/lib/backup/`, `src/components/settings/backup-panel.tsx`

## 11. Demo page — **New**

A presentation page for prospects, built around the broadcast funnel and AI training, plus an animated automation chat. It has a full-screen **Present** mode.

Where: sidebar → Demo. Code: `src/app/(dashboard)/demo/`, `src/components/demo/`

## 12. Guide and developer API

- **In-app Guide:** a chapter for every tab, plus What's new (one folder per update in `Guide/updates/`).
- **REST API** (`/api/v1`) with API keys and signed webhooks.
- **MCP server** in `mcp-server/`.
