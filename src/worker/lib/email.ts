// Outbound email via the Cloudflare Email Service `send_email` binding (EMAIL).
// No API keys: the binding sends from any address on an onboarded domain. Local
// dev sets DISABLE_EMAIL_SEND=true (.dev.vars, never in production) to log the
// message — including the verification link — to the console instead of sending,
// which is what wrangler dev wants. Without the binding and not disabled,
// delivery FAILS CLOSED. A false return means "not delivered"; callers must
// surface that, not pretend.

import type { Env } from "../env";

// `text` is the required plain-text body — the fallback for clients that don't
// render HTML and what the DISABLE_EMAIL_SEND dev log prints. `html` is an
// optional richer version; when present it's passed alongside text (never
// instead of it) so every recipient sees a sensible message.
export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  text: string,
  html?: string
): Promise<boolean> {
  if (env.DISABLE_EMAIL_SEND === "true") {
    console.log(`[email:dev] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return true;
  }
  if (!env.EMAIL) {
    console.error("email: EMAIL binding not configured — refusing to drop mail silently");
    return false;
  }
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.EMAIL_FROM ?? "noreply@showustv.com", name: env.EMAIL_FROM_NAME ?? "Show Us TV" },
      subject,
      text,
      ...(html ? { html } : {}),
    });
    return true;
  } catch (e) {
    console.error("email: send failed", e);
    return false;
  }
}

// Minimal HTML-escaping for values interpolated into the email template.
// Covers both attribute (href) and text contexts. The link is
// origin + hex token so this is defence-in-depth, not a live vector.
function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

// A branded transactional-email shell that echoes the site's identity: dark
// slate card, amber accent, and the "SHOW US TV" wordmark rendered as styled
// text (the app draws it as text/SVG, never an image, so nothing to fetch).
// Table-based layout with inline styles only — no external CSS/JS/images, and
// no inline SVG, so it renders reliably across email clients (Gmail, Outlook,
// Apple Mail). The CTA is a real <a href> so it still works if styles are
// stripped, and the raw URL is repeated as a copy-paste fallback.
// Kept generic (heading/intro/button/footnote) so any future transactional
// mail — e.g. a password reset — can reuse the same template.
export function brandedEmailHtml(opts: {
  preheader: string;
  heading: string;
  intro: string;
  buttonLabel: string;
  buttonUrl: string;
  footnote: string;
}): string {
  const body = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const display = "Georgia,'Times New Roman',serif";
  const url = escapeHtml(opts.buttonUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${escapeHtml(opts.heading)}</title>
</head>
<body style="margin:0; padding:0; background-color:#0f1218; color:#ede9e0; font-family:${body};">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; color:#0f1218;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0f1218;">
<tr>
<td align="center" style="padding:32px 16px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:480px; background-color:#171c26; border:1px solid #2a3344; border-radius:12px;">
<tr>
<td style="padding:32px;">
<div style="font-family:${display}; font-style:italic; font-weight:bold; font-size:22px; letter-spacing:-0.5px; color:#ede9e0;">SHOW&nbsp;US <span style="font-style:normal; display:inline-block; background-color:#ffae2e; color:#1a1205; padding:1px 7px; border-radius:5px; font-size:17px; letter-spacing:0;">TV</span></div>
<h1 style="margin:28px 0 12px 0; font-family:${display}; font-size:22px; font-weight:bold; color:#ede9e0;">${escapeHtml(opts.heading)}</h1>
<p style="margin:0 0 24px 0; font-family:${body}; font-size:15px; line-height:1.6; color:#c7ccd6;">${escapeHtml(opts.intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td align="center" bgcolor="#ffae2e" style="border-radius:8px;">
<a href="${url}" style="display:inline-block; padding:12px 28px; font-family:${body}; font-size:15px; font-weight:bold; color:#1a1205; text-decoration:none; border-radius:8px;">${escapeHtml(opts.buttonLabel)}</a>
</td>
</tr>
</table>
<p style="margin:24px 0 6px 0; font-family:${body}; font-size:13px; color:#8e97a8;">Or paste this link into your browser:</p>
<p style="margin:0 0 4px 0; font-family:${body}; font-size:13px; word-break:break-all;"><a href="${url}" style="color:#56cfde; text-decoration:underline;">${url}</a></p>
<hr style="border:none; border-top:1px solid #2a3344; margin:24px 0;">
<p style="margin:0; font-family:${body}; font-size:13px; line-height:1.6; color:#8e97a8;">${escapeHtml(opts.footnote)}</p>
</td>
</tr>
</table>
<p style="margin:20px 0 0 0; font-family:${body}; font-size:12px; color:#5b6472;">Show Us TV</p>
</td>
</tr>
</table>
</body>
</html>`;
}

// Verification tokens are bearer credentials — only their digest is
// persisted, so a DB leak can't verify emails.
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
