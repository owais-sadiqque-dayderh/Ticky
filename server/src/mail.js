/**
 * Ticket email. Optional: without SMTP_URL the ticket is shown on screen only
 * (the registration page already says "Screenshot this").
 */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function createMailer({ smtpUrl, mailFrom }) {
  if (!smtpUrl) return null;
  if (!mailFrom) throw new Error('SMTP_URL is set but MAIL_FROM is not.');

  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport(smtpUrl);

  return {
    async sendTicket({ to, name, event, ticketId, qrUrl }) {
      const when = [event.dateLabel, event.timeLabel].filter(Boolean).join(', ');
      const text = [
        `Hi ${name},`,
        '',
        `You're in for ${event.name} ${event.edition}.`,
        `${when} — doors ${event.doorsLabel}`,
        event.venueLine,
        '',
        `Ticket no. ${ticketId}`,
        'Your entry QR is attached.',
        '',
        'Show the QR at the door. If it will not scan, staff can type the ticket number in.',
        event.supportEmail ? `Questions: ${event.supportEmail}` : ''
      ].join('\n');

      const html = `
        <p>Hi ${escapeHtml(name)},</p>
        <p>You're in for <strong>${escapeHtml(event.name)} ${escapeHtml(event.edition)}</strong>.<br>
           ${escapeHtml(when)} &middot; doors ${escapeHtml(event.doorsLabel)}<br>
           ${escapeHtml(event.venueLine)}</p>
        <p><img src="cid:ticket-qr" width="240" height="240" alt="Entry QR code"></p>
        <p>Ticket no. <strong style="font-family:monospace;letter-spacing:0.1em">${escapeHtml(ticketId)}</strong></p>
        <p>Show the QR at the door. If it will not scan, staff can type the ticket number in.</p>
        ${event.supportEmail ? `<p>Questions: <a href="mailto:${escapeHtml(event.supportEmail)}">${escapeHtml(event.supportEmail)}</a></p>` : ''}
      `;

      await transport.sendMail({
        from: mailFrom,
        to,
        subject: `Your ticket — ${event.name} ${event.edition}`,
        text,
        html,
        // Attached rather than linked, so no image host ever sees the door pass.
        attachments: [{ filename: `${ticketId}.png`, path: qrUrl, cid: 'ticket-qr' }]
      });
    }
  };
}
