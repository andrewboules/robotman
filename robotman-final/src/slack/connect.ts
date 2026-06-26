/**
 * CONNECT FLOW (per-user credentials)
 * -----------------------------------
 * Lets each recruiter connect their own API key for any integration without
 * pasting it into chat. Three entry points, all opening the same secure modal:
 *   - `/connect [provider]` slash command
 *   - a "Connect <provider>" button the agent can surface in conversation
 * The modal collects Site/Base URL + API key; on submit we encrypt + store it
 * per user. Modal inputs are not echoed into channel history, unlike a typed
 * message — that's why we collect keys here, never in the DM thread.
 *
 * Requires Interactivity to be enabled on the Slack app (Socket Mode needs no
 * URL — just the toggle).
 */
import bolt from "@slack/bolt";
import type { CredentialService } from "../identity/credentials.js";
import { GOOGLE_ALIASES, SLACK_OAUTH_ALIASES } from "../agent/tools.js";

const { App } = bolt;
type App = InstanceType<typeof App>;

export const CONNECT_MODAL_CALLBACK = "connect_modal";
export const CONNECT_ACTION_PREFIX = "connect:"; // button action_id => connect:<provider>

/** Builds the modal view. `provider` pre-fills the field when known. */
function connectModalView(provider: string) {
  return {
    type: "modal" as const,
    callback_id: CONNECT_MODAL_CALLBACK,
    private_metadata: provider,
    title: { type: "plain_text" as const, text: "Connect integration" },
    submit: { type: "plain_text" as const, text: "Save" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "input" as const,
        block_id: "provider_block",
        label: { type: "plain_text" as const, text: "Integration" },
        element: {
          type: "plain_text_input" as const,
          action_id: "provider",
          initial_value: provider,
          placeholder: { type: "plain_text" as const, text: "e.g. ashby, gem, granola" },
        },
      },
      {
        type: "input" as const,
        block_id: "site_block",
        optional: true,
        label: { type: "plain_text" as const, text: "Site / Base URL (optional)" },
        element: {
          type: "plain_text_input" as const,
          action_id: "site",
          placeholder: { type: "plain_text" as const, text: "e.g. https://api.ashbyhq.com" },
        },
      },
      {
        type: "input" as const,
        block_id: "key_block",
        label: { type: "plain_text" as const, text: "API key" },
        element: {
          type: "plain_text_input" as const,
          action_id: "api_key",
          placeholder: { type: "plain_text" as const, text: "Paste your API key" },
        },
      },
      {
        type: "context" as const,
        elements: [
          {
            type: "mrkdwn" as const,
            text: "🔒 Your key is encrypted and stored only for you. It is never shown in chat.",
          },
        ],
      },
    ],
  };
}

/** Slack Block Kit for a "Connect <provider>" button (used in agent replies). */
export function connectButtonBlocks(provider: string) {
  return [
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: `${CONNECT_ACTION_PREFIX}${provider}`,
          text: { type: "plain_text", text: `Connect ${provider}` },
          style: "primary",
        },
      ],
    },
  ];
}

export function registerConnectHandlers(app: App, credentials: CredentialService): void {
  // /connect [provider]
  app.command("/connect", async ({ ack, body, client }) => {
    await ack();
    const provider = (body.text ?? "").trim().toLowerCase();
    if (!credentials.enabled) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: connectModalView(provider),
    });
  });

  // "Connect <provider>" button → open modal pre-filled.
  app.action(new RegExp(`^${CONNECT_ACTION_PREFIX}`), async ({ ack, body, client, action }) => {
    await ack();
    const actionId = (action as { action_id?: string }).action_id ?? "";
    const provider = actionId.slice(CONNECT_ACTION_PREFIX.length);
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!triggerId || !credentials.enabled) return;
    await client.views.open({ trigger_id: triggerId, view: connectModalView(provider) });
  });

  // Modal submit → encrypt + store the credential for this user.
  app.view(CONNECT_MODAL_CALLBACK, async ({ ack, body, view, client }) => {
    const values = view.state.values;
    const provider = values.provider_block?.provider?.value?.trim().toLowerCase() ?? "";
    const site = values.site_block?.site?.value?.trim() ?? "";
    const apiKey = values.key_block?.api_key?.value?.trim() ?? "";

    const errors: Record<string, string> = {};
    if (!provider) errors.provider_block = "Enter the integration name.";
    if (GOOGLE_ALIASES.has(provider)) {
      errors.provider_block = "Google services use the Connect Google button, not an API key.";
    }
    if (SLACK_OAUTH_ALIASES.has(provider)) {
      errors.provider_block = "Slack workspace uses the Connect with Slack button, not an API key.";
    }
    if (!apiKey) errors.key_block = "Enter your API key.";
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: "errors", errors });
      return;
    }

    await ack();
    await credentials.set(body.user.id, provider, site || null, apiKey);
    // Confirm in a DM (modal inputs don't appear in chat, so confirm separately).
    try {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Connected *${provider}*${site ? ` (${site})` : ""}. Your key is encrypted and stored only for you.`,
      });
    } catch {
      /* posting confirmation is best-effort */
    }
  });
}
