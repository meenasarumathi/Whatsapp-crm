# Instagram

Answer Instagram DMs, comments and story mentions from the CRM — automatically, with your automations, quick replies and the AI trained on your business.

## What you can do

- **Inbox** — every Instagram conversation in one list; open one to read the DMs, comments and story mentions and reply by hand.
- **Automations** — the five basics, ready to switch on.
- **AI auto-reply** — when no automation matches, the AI answers DMs from Train AI and your documents.
- **Simulator** — try everything before Instagram is connected.

## The five automations

| Automation | Starts when | What it sends |
| --- | --- | --- |
| **Comment → DM** | Someone comments a keyword (e.g. PRICE) on a post — or any comment if no keywords | A private DM with the details, plus an optional public reply like "Sent you a DM 📩". Limit it to one post with **Only this post**. |
| **Keyword reply** | A DM contains a keyword (price, order, buy…) | Your prepared answer. |
| **Welcome DM** | Someone messages you for the first time | A greeting. |
| **Story mention thanks** | Someone tags you in their story | A thank-you, e.g. with a discount code. |
| **Away message** | A DM arrives outside your hours | When you will reply. Sent once per 12 hours per person. |

Each automation starts as a draft: edit the text, click **Save**, then switch it on. **Reply with** can use custom text or one of your **Quick replies** (Settings → Quick replies) as a ready-made template. Use {{name}} for the customer's @username.

Only one automation answers a message. Order: comment → story mention → keyword → welcome → away; if none matches and **AI auto-reply on Instagram** is on, the AI answers.

## Connect your account (Connect & test)

1. In Meta for Developers, add the **Instagram** product (API setup with Instagram login) to your app.
2. Under **Webhooks**, paste the **Callback URL** and **Verify token** shown in the CRM, then subscribe to **messages** and **comments**.
3. Generate an access token with `instagram_business_manage_messages` and `instagram_business_manage_comments`, paste it into **Instagram access token** and click **Save & check**. The CRM checks the token and shows **Connected · @yourname**.
4. If your Instagram app has its own secret, paste it into **Instagram app secret** (otherwise `META_APP_SECRET` is used to check webhook signatures).
5. Before every customer can use it, Meta's **App Review** must approve the two permissions.

> **Tip:** Until a token is saved the tab runs in **Simulation mode**: replies are stored and shown as **simulated**, nothing is sent and no tokens are charged.

## Testing with the simulator

Under **Try it without Instagram** choose a **Direct message**, **Comment on a post**, **Story mention** or **Reply to your story**, type the text and a @username, and click **Simulate message**. Open **Inbox** to see what the customer would receive.

## Costs and limits

- Automated and AI replies use the token wallet like WhatsApp (automation and AI agent). Your manual replies are free.
- Instagram only lets businesses reply within 24 hours of the customer's last message.
- Only Instagram professional (business or creator) accounts can be connected.
