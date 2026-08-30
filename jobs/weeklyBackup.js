// jobs/weeklyBackup.js
// Runs once a week. Creates a full timestamped copy of the subscription
// spreadsheet in Google Drive, so there's always a recent snapshot to
// restore from if something is accidentally deleted or overwritten.

const { backupSheet } = require('../lib/backup');

async function runWeeklyBackup() {
  console.log(`[${new Date().toISOString()}] Running weekly sheet backup...`);
  try {
    const result = await backupSheet();
    console.log(`Backup created: "${result.name}" (id: ${result.id})`);
  } catch (err) {
    console.error('Weekly backup failed:', err.message);
  }
}

module.exports = { runWeeklyBackup };
