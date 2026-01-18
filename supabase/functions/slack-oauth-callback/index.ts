import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return new Response(
        JSON.stringify({ error: "Missing code or state parameter" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Exchange code for access token
    const clientId = Deno.env.get("SLACK_CLIENT_ID");
    const clientSecret = Deno.env.get("SLACK_CLIENT_SECRET");
    const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/slack-oauth-callback`;

    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({ error: "Slack OAuth not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.ok) {
      console.error("Slack OAuth error (full response):", tokenData);
      return new Response(
        JSON.stringify({ error: "Failed to authenticate with Slack" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Normalize token/team/webhook fields (handle variations in Slack's response)
    const accessToken = tokenData.access_token ?? tokenData.authed_user?.access_token ?? null;
    const teamId = tokenData.team?.id ?? tokenData.team_id ?? null;
    const teamName = tokenData.team?.name ?? tokenData.team_name ?? null;
    const incomingWebhookUrl = tokenData.incoming_webhook?.url ?? tokenData.incoming_webhook_url ?? null;
    const incomingWebhookChannel = tokenData.incoming_webhook?.channel ?? tokenData.incoming_webhook?.channel_id ?? null;

    // Diagnostic logging (do NOT log secret tokens in production)
    console.log("Slack tokenData fields:", {
      hasAccessToken: !!accessToken,
      hasTeamId: !!teamId,
      hasIncomingWebhook: !!incomingWebhookUrl,
    });

    if (!accessToken) {
      console.error("No access token found in Slack response", tokenData);
      // still proceed if desired, but usually the token is required to use Slack APIs
      // return an error so it's obvious to the user/devs
      return new Response(
        JSON.stringify({ error: "Slack did not return an access token" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Ensure service role key is present (we need it to write to profiles)
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceRoleKey) {
      console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
      return new Response(
        JSON.stringify({ error: "Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Update user profile with Slack tokens
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      serviceRoleKey
    );

    const userId = state; // state contains the user ID

    const { error: updateError } = await supabaseClient
      .from("profiles")
      .update({
        slack_access_token: accessToken,
        slack_team_id: teamId,
        slack_team_name: teamName,
        slack_channel: incomingWebhookChannel ?? null,
        slack_webhook_url: incomingWebhookUrl ?? null,
        slack_connected_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (updateError) {
      console.error("Database update error:", updateError);
      return new Response(
        JSON.stringify({ error: "Failed to save Slack connection", details: updateError }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Redirect back to app with success message
    const appUrl = Deno.env.get("APP_URL") || "http://localhost:5173";

    // Create a simple HTML page that closes the window and notifies parent
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Slack Connected</title>
        </head>
        <body>
          <h1>Successfully connected to Slack!</h1>
          <p>You can close this window and return to the app.</p>
          <script>
            // Try to close the window
            window.close();

            // If window doesn't close, redirect after 2 seconds
            setTimeout(() => {
              window.location.href = '${appUrl}';
            }, 2000);
          </script>
        </body>
      </html>
    `;

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
      },
    });
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});