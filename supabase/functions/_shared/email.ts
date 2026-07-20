/* ============================================================
   SHARED PORTAL EMAIL TEMPLATE
   Built to TJA's production newsletter design (Cameron sent the
   Mailchimp HTML, 2026-07-20): light-grey canvas, logo top-left,
   ORANGE left-border accent on the content block, bold Arial
   headings with tight tracking, pill CTA button (orange border,
   uppercase, arrow icon), black footer with contact + socials.

   Transactional emails are simpler than the newsletter, so this is
   the header + ONE accented content block + a black footer. Every
   email the portal sends (deliverable-ready, client invite, …)
   goes through portalEmail() so they're one consistent brand.

   Brand orange is #f78f22 (from the newsletter — note it differs
   slightly from the app UI's #F68E21). Table-based + inline styles:
   the one layout every mail client (Outlook/Gmail/Apple) honours.
   ============================================================ */

const ORANGE = "#f78f22";
const LOGO = "https://mcusercontent.com/877bc2a21a7f5005065ec6183/images/2fb815dc-5831-b1db-49f2-c1ebfef09ae3.gif";
const ARROW = "https://mcusercontent.com/877bc2a21a7f5005065ec6183/images/486bbe00-1b5a-a980-256d-c127fb4b1fc0.png"; // orange arrow

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export interface PortalEmailOpts {
  preheader: string;                 // hidden inbox-preview line
  heading: string;                   // big Arial headline
  bodyHtml: string;                  // trusted HTML (callers esc() their own dynamic bits)
  metaRows?: [string, string][];     // e.g. [["Feedback due","July 25, 2026"]]
  ctaText?: string;                  // pill button label
  ctaUrl?: string;
}

// One accented content block. Reused by every portal email.
export function portalEmail(o: PortalEmailOpts): string {
  const meta = (o.metaRows || []).filter(([, v]) => v)
    .map(([k, v]) =>
      `<p style="color:#000;margin:0 0 6px;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:1.4em">
         <b>${esc(k)}:</b> ${esc(v)}</p>`).join("");

  const cta = (o.ctaText && o.ctaUrl) ? `
    <table role="presentation" class="tjaButton" style="height:30px;margin:24px 0 6px" border="0" cellpadding="0" cellspacing="0" align="left">
      <tbody><tr>
        <td height="30" style="height:30px;border-radius:25px" align="left" bgcolor="#ffffff">
          <a target="_blank" href="${o.ctaUrl}" style="border:2px solid ${ORANGE};color:${ORANGE};display:block;line-height:30px;height:30px;font-size:14px;text-align:left;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-weight:bold;padding:5px 16px 5px 20px;text-transform:uppercase;border-radius:25px;vertical-align:middle;-webkit-text-size-adjust:none">
            ${esc(o.ctaText)} <img src="${ARROW}" width="22" height="22" style="padding:0 2px 2px 6px;vertical-align:middle" alt=""></a>
        </td>
      </tr></tbody>
    </table>` : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html><head>
  <meta http-equiv="content-type" content="text/html; charset=UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="x-ua-compatible" content="IE=Edge">
</head>
<body style="margin:0;padding:0;background-color:#eeeeee;-webkit-font-smoothing:antialiased">
  <span style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;opacity:0;overflow:hidden;visibility:hidden;mso-hide:all">${esc(o.preheader)}</span>
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" align="center" bgcolor="#eeeeee">
    <tbody><tr><td style="padding:0 20px" bgcolor="#eeeeee" align="center">
      <table role="presentation" style="max-width:600px;width:100%" border="0" cellpadding="0" cellspacing="0" align="center">
        <tbody>
          <!-- header: logo -->
          <tr><td bgcolor="#ffffff" style="padding:22px 24px 18px">
            <a target="_blank" href="https://thejamesagency.com"><img width="205" src="${LOGO}" alt="The James Agency" border="0" style="width:205px;max-width:205px;display:block"></a>
          </td></tr>
          <!-- accent spacer -->
          <tr><td bgcolor="#eeeeee" style="padding:2px 0;font-size:1px;line-height:1px">&nbsp;</td></tr>
          <!-- content block, orange left border -->
          <tr><td bgcolor="#ffffff" style="padding:32px 44px 40px;border-left:2px solid ${ORANGE}">
            <h1 style="font-size:30px;font-family:Arial,Helvetica,sans-serif;font-weight:bold;text-align:left;margin:0 0 16px;line-height:1.05em;letter-spacing:-1.5px;color:#000">${esc(o.heading)}</h1>
            <div style="color:#000;font-size:15px;font-family:Arial,Helvetica,sans-serif;text-align:left;line-height:1.5em">${o.bodyHtml}</div>
            ${meta ? `<div style="margin-top:16px">${meta}</div>` : ""}
            ${cta}
          </td></tr>
          <!-- footer: black, contact + socials -->
          <tr><td bgcolor="#000000" style="padding:22px 30px">
            <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tbody><tr>
              <td valign="top" style="text-align:left;color:#fff;line-height:1.6em;font-family:Arial,Helvetica,sans-serif;font-size:12px">
                <a href="tel:4802486710" style="color:#fff;text-decoration:none">480.248.6710</a> | <a href="mailto:info@thejamesagency.com" style="color:#fff;text-decoration:none">info@thejamesagency.com</a><br>
                <a href="https://goo.gl/maps/YThRjZ9hB6r" target="_blank" style="text-decoration:none;color:#fff">6240 E Thomas Rd, Suite 200<br>Scottsdale, AZ 85251</a><br><br>
                <span style="font-size:11px;line-height:1.2em;color:#aaa">© 2026 The James Agency. All rights reserved.</span>
              </td>
              <td valign="top" align="right" style="text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#fff;line-height:1.5em">
                <strong>
                  <a href="https://www.instagram.com/thejamesagency/" target="_blank" style="color:#fff;text-decoration:none;letter-spacing:-1px">Instagram</a><br>
                  <a href="https://www.facebook.com/TheJamesAgency/" target="_blank" style="color:#fff;text-decoration:none;letter-spacing:-1px">Facebook</a><br>
                  <a href="https://www.linkedin.com/company/508711/" target="_blank" style="color:#fff;text-decoration:none;letter-spacing:-1px">LinkedIn</a><br>
                  <a href="https://www.tiktok.com/@thejamesagency" target="_blank" style="color:#fff;text-decoration:none;letter-spacing:-1px">TikTok</a>
                </strong>
              </td>
            </tr></tbody></table>
          </td></tr>
        </tbody>
      </table>
    </td></tr></tbody>
  </table>
</body></html>`;
}
