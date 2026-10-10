# Train AI

A new **Train AI** tab (below Inbox) teaches the AI assistant about your business, step by step, with an AI readiness score.

## What changed

- New sidebar tab **Train AI** between Inbox and Notifications.
- Steps: Business profile, Q&A answers, Rules, Learn from chats, Documents, Test it, and What AI can do.
- Training is saved in the database (tables `ai_training_profiles` and `ai_training_examples`), and the AI uses it in inbox drafts, auto-replies and the Playground.
- Q&A answers can be imported from and exported to Excel.
- Learn from chats turns good inbox conversations into answers in a few clicks.
- An AI readiness score (0–100) with a checklist of what to do next.

## Who it affects

- Roles: Owner, Admin and Agent can train. Viewers can read. Uploading documents needs Owner or Admin.
- Tabs: Train AI, AI Agents (Playground), Inbox (Draft with AI and auto-reply).

## How to use it

1. Run `supabase/migrations/044_ai_training.sql` once in the Supabase SQL editor.
2. Open **Train AI** and fill in the **Business profile**.
3. Add your top questions under **Q&A answers**, and a few **Rules**.
4. Check the result in **Test it**.

## Related guide chapters updated

- New chapter: Train AI
- AI Agents (pointer to Train AI)
- Getting started → The screen layout
