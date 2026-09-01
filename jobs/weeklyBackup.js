// jobs/weeklyBackup.js
// Runs once a week. Creates a full timestamped copy of the subscription
// spreadsheet in Google Drive, so there's always a recent snapshot to
// restore from if something is accidentally deleted or overwritten. Then
// immediately opens that copy back up and sanity-checks it (verifyBackup)
// — same tabs as the live sheet, roughly the same row count — so a broken
// or incomplete backup is caught the week it happens, not the day someone
// actually needs to restore from it.

const { backupSheet, verifyBackup } = require('../lib/backup');
const { sendBackupVerificationAlert } = require('../lib/email');

async function runWeeklyBackup() {
    console.log(`[${new Date().toISOString()}] Running weekly sheet backup...`);
    let result;
    try {
          result = await backupSheet();
          console.log(`Backup created: "${result.name}" (id: ${result.id})`);
    } catch (err) {
          console.error('Weekly backup failed:', err.message);
          return;
    }

  try {
        const verification = await verifyBackup(result.id);
        if (verification.ok) {
                console.log(
                          `Backup verified OK (${verification.backupRowCount}/${verification.liveRowCount} rows, all tabs present).`
                        );
        } else {
                console.warn('Backup verification found a problem:', JSON.stringify(verification));
                await sendBackupVerificationAlert(verification);
        }
  } catch (err) {
        // The backup itself still succeeded above — a failure here just means
      // we couldn't verify it, not that the backup is necessarily bad. Worth
      // knowing either way, but not worth escalating as loudly.
      console.error('Backup verification check itself failed:', err.message);
  }
}

module.exports = { runWeeklyBackup };
