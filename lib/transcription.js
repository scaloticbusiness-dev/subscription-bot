// lib/transcription.js
// Wraps the AssemblyAI speech-to-text API. Submits a direct media URL for
// transcription and polls until it's done. AssemblyAI needs a direct,
// publicly-accessible link to the actual audio/video file — not a YouTube
// watch page or a Google Drive "view" link (those return an HTML page,
// not the raw file). For Google Drive, use the direct-download form:
// https://drive.google.com/uc?export=download&id=FILE_ID

const ASSEMBLYAI_API_URL = 'https://api.assemblyai.com/v2';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 180; // ~15 minutes max wait, matches Discord's follow-up edit window

function headers() {
  return {
    Authorization: process.env.ASSEMBLYAI_API_KEY,
    'Content-Type': 'application/json',
  };
}

/**
 * Submits a direct media URL for transcription and polls until it
 * completes. Returns { text, durationSeconds }. Throws on any failure
 * (missing API key, bad URL, AssemblyAI-side error, or timeout).
 */
async function transcribeUrl(audioUrl) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new Error('ASSEMBLYAI_API_KEY not configured.');
  }

  const submitRes = await fetch(`${ASSEMBLYAI_API_URL}/transcript`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ audio_url: audioUrl }),
  });
  if (!submitRes.ok) {
    throw new Error(`AssemblyAI submit failed: ${submitRes.status} ${await submitRes.text()}`);
  }
  const submitData = await submitRes.json();
  const transcriptId = submitData.id;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const pollRes = await fetch(`${ASSEMBLYAI_API_URL}/transcript/${transcriptId}`, {
      headers: headers(),
    });
    if (!pollRes.ok) {
      throw new Error(`AssemblyAI poll failed: ${pollRes.status} ${await pollRes.text()}`);
    }
    const pollData = await pollRes.json();

    if (pollData.status === 'completed') {
      return { text: pollData.text || '', durationSeconds: pollData.audio_duration || null };
    }
    if (pollData.status === 'error') {
      throw new Error(`AssemblyAI transcription error: ${pollData.error}`);
    }
    // else still 'queued' or 'processing' — keep polling
  }

  throw new Error('Transcription timed out after 15 minutes.');
}

module.exports = { transcribeUrl };
