# AI training

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

## Update history

| Date | Change |
| --- | --- |
| 2026-10-10 | Added in this release — see [release notes](../2026-10-10-release/README.md). |
