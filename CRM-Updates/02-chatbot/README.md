# Chatbot (Flows)

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

## Update history

| Date | Change |
| --- | --- |
| 2026-10-10 | Original feature; new items marked **New** were added in this release — see [release notes](../2026-10-10-release/README.md). |
