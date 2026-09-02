// jobs/checkTicketSLA.js
// Runs every 30 minutes (frequent enough to catch an SLA breach within
// half an hour of it happening, unlike the once-a-day checks). Reads the
// "Support Tickets" tab (lib/supportTickets.js) and finds every still-open
// ticket (no First Response At, no Closed At) that's been waiting longer
// than TICKET_SLA_HOURS (default 24) without a reply from support — then
// sends the admin one summary email listing all of them, once per ticket
// (Alert Sent guards against re-alerting on every run).

const { getAllTickets, updateTicketRow } = require('../lib/supportTickets');
const { sendTicketSLAAlert } = require('../lib/email');

const DEFAULT_SLA_HOURS = 24;

function hoursSince(dateStr) {
  const start = new Date(dateStr);
  if (isNaN(start.getTime())) return null;
  return (Date.now() - start.getTime()) / (1000 * 60 * 60);
}

async function checkTicketSLA() {
  console.log(`[${new Date().toISOString()}] Running ticket SLA check...`);

  if (!process.env.TICKET_CATEGORY_ID) {
    console.log('TICKET_CATEGORY_ID not set — skipping ticket SLA check.');
    return;
  }

  const slaHours = Number(process.env.TICKET_SLA_HOURS) || DEFAULT_SLA_HOURS;
  const tickets = await getAllTickets();

  const stillOpen = tickets.filter((t) => !t.firstResponseAt && !t.closedAt);
  const due = [];

  for (const ticket of stillOpen) {
    try {
      if (ticket.alertSent === 'Yes') continue; // already flagged once, don't repeat

      const hours = hoursSince(ticket.openedAt);
      if (hours === null) {
        console.warn(`Skipping ticket row ${ticket.rowNumber} (#${ticket.channelName}): invalid Opened At "${ticket.openedAt}".`);
        continue;
      }

      if (hours >= slaHours) {
        due.push({ rowNumber: ticket.rowNumber, channelName: ticket.channelName, channelId: ticket.channelId, hoursOpen: Math.floor(hours) });
      }
    } catch (err) {
      console.error(`Failed to process ticket row ${ticket.rowNumber} (#${ticket.channelName}):`, err.message);
    }
  }

  if (due.length > 0) {
    try {
      await sendTicketSLAAlert({ tickets: due, slaHours });
      for (const item of due) {
        await updateTicketRow(item.rowNumber, { alertSent: 'Yes' });
      }
    } catch (err) {
      console.error('Failed to send ticket SLA alert:', err.message);
    }
  }

  console.log(`Ticket SLA check complete. ${due.length} ticket(s) breached SLA and were alerted.`);
}

module.exports = { checkTicketSLA };
