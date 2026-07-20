const textEl = document.getElementById('text');
const voiceIdEl = document.getElementById('voiceId');
const speakBtn = document.getElementById('speak');
const statusEl = document.getElementById('status');
const player = document.getElementById('player');

let lastObjectUrl = null;

async function speak() {
  const text = textEl.value.trim();
  if (!text) {
    statusEl.textContent = 'Type something first.';
    return;
  }

  speakBtn.disabled = true;
  statusEl.textContent = 'Requesting audio...';

  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice_id: voiceIdEl.value.trim() || undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }

    // Buffer the streamed response into a Blob, then hand it to the
    // browser's Audio element via an object URL for playback.
    const blob = await res.blob();
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = URL.createObjectURL(blob);

    player.src = lastObjectUrl;
    await player.play();
    statusEl.textContent = 'Playing.';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    speakBtn.disabled = false;
  }
}

speakBtn.addEventListener('click', speak);
