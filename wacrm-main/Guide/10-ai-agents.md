# AI Agents

An optional AI assistant that drafts replies for your team and can answer customers automatically, using your own OpenAI or Anthropic key.

The page has three tabs: **Playground**, **Setup** and **Usage** (Usage is admin-only). New accounts open on **Setup**.

> **Tip:** To teach the AI about your business — profile, example answers, rules, learning from chats — use the **Train AI** tab in the sidebar. See the Train AI chapter.

## Setup (admin)

### Provider & key

1. Choose the **Provider** (OpenAI or Anthropic) and a **Model**.
2. Paste your **API key** and click **Test key** — you should see "Key works".
3. Optional: an **Embeddings key** (OpenAI) turns on smarter "semantic" search of your knowledge base. Without it, keyword search is used.

Keys are stored encrypted and never shown again.

### Behaviour

- **Business context & instructions** — tell the AI who you are, your tone, and what it must never promise. Example: "We are Acme, a coffee-equipment store. Be warm and concise. Never quote prices — hand off to a human."
- **Enable AI assistant** — master switch. Turns on **Draft with AI** in the Inbox.
- **Auto-reply to inbound messages** — the bot answers new messages by itself, but only when no flow is handling the chat and no agent is assigned.
- **Max auto-replies per conversation** — after this many bot replies the bot goes quiet.
- **Hand off to** — where chats go when the bot cannot help: a specific teammate or the **Unassigned queue**.

Click **Save**. **Remove** deletes the whole AI configuration.

### Knowledge base

Add documents the AI can look up: FAQs, return policies, product details.

1. Click **Add document**, enter a **Title** and paste the **Content**.
2. Click **Save document**. Use **Edit** / **Delete** to maintain them.
3. **Reindex** re-processes all documents (use it after adding an embeddings key).

## Playground

Test the AI as if you were a customer — nothing is sent to anyone.

1. Type a customer-style question and send it.
2. Read the reply. If it says "Would hand off to a human here", the bot would pass the chat to your team.
3. Improve the Business context or knowledge base and try again. **Reset** clears the test chat.

## Usage (admin)

Shows tokens used on your provider key over recent days: **Total tokens**, **LLM calls**, split by **Auto-reply** and **Drafts**, a **Tokens per day** chart and usage **By model**. Only counts are stored, never message content.

## Using AI in the Inbox

- **✨ Draft with AI** in the composer writes a suggestion you can edit before sending.
- When auto-reply is on, AI-sent messages carry an **AI** badge, and the thread shows an AI banner with **Take over** / **Resume AI**.

> **Tip:** Always test new instructions in the Playground before switching on auto-reply.
