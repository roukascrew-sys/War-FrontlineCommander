# ElevenLabs TTS Backend

Minimal Flask app that proxies text-to-speech requests to the ElevenLabs API and
streams the result back as `audio/mpeg`. The API key lives only on the server.

## Setup

```bash
cd elevenlabs-tts-backend
pip install -r requirements.txt
cp .env.example .env   # then edit .env and paste your real key
python app.py
```

Open http://localhost:5000 — type some text, optionally a voice ID, and click Speak.

## API

`POST /api/tts`

```json
{ "text": "Hello there", "voice_id": "21m00Tcm4TlvDq8ikWAM" }
```

`voice_id` is optional if `ELEVENLABS_DEFAULT_VOICE_ID` is set in `.env`. Response is a
streamed `audio/mpeg` body on success, or JSON `{"error": "..."}` with a 4xx/5xx status
on failure (missing text, missing server key, etc.).

## Files

- `app.py` — the Flask route
- `static/index.html`, `static/app.js` — a small demo page that calls the route and
  plays the result through the browser's `Audio` element
- `.env.example` — copy to `.env`, never commit the real `.env`
