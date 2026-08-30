// jobs/checkArchive.js
// Runs once a day. Moves rows that have been "Expired" for more than 90
// days into a separate "Archive" tab in the same spreadsheet, keeping the
// main sheet focused on current/recent members. Nothing is deleted for
// good — it just lives in the Archive tab instead.

const { getAllRows, archiveRow, deleteRow } = require('../lib/sheets');

const ARCHIVE_AFTER_DAYS = 90;

function daysSince(dateStr) {
  const start = new Date(dateStr);
  if (isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

async function runArchiveCheck() {
  console.log(`[${new Date().toISOString()}] Running daily archive check...`);
  const rows = await getAllRows();

  // Sort by rowNumber descending so that deleting a row doesn't shift the
  // row numbers of the other candidates still waiting to be processed.
  const candidates = rows
    .filter((r) => r.status.toLowerCase() === 'expired' && r.expiredDate)
    .filter((r) => {
      const days = daysSince(r.expiredDate);
      return days !== null && days >= ARCHIVE_AFTER_DAYS;
    })
    .sort((a, b) => b.rowNumber - a.rowNumber);

  let archivedCount = 0;

  for (const row of candidates) {
    try {
      await archiveRow(row);
      await deleteRow(row.rowNumber);
      console.log(`Archived row ${row.rowNumber} (${row.email})`);
      archivedCount += 1;
    } catch (err) {
      console.error(`Failed to archive row ${row.rowNumber} (${row.email}):`, err.message);
    }
  }

  console.log(`Archive check complete. Archived ${archivedCount} row(s).`);
}

module.exports = { runArchiveCheck };
