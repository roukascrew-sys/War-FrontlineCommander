"""Flask backend that proxies text-to-speech requests to ElevenLabs.

The API key never leaves the server: it is read once from the environment
and used only in outbound calls to ElevenLabs. The frontend sends text and
a voice_id; the response is streamed straight through as audio/mpeg so the
browser can start playing before the whole clip has been generated.
"""
import os

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from flask import Flask, Response, jsonify, request, send_from_directory

load_dotenv()

API_KEY = os.environ.get("ELEVENLABS_API_KEY")
DEFAULT_MODEL_ID = os.environ.get("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
DEFAULT_VOICE_ID = os.environ.get("ELEVENLABS_DEFAULT_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
MAX_TEXT_LENGTH = 5000

app = Flask(__name__, static_folder="static", static_url_path="")
client = ElevenLabs(api_key=API_KEY) if API_KEY else None


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/tts")
def text_to_speech():
    if not client:
        return jsonify(error="Server is missing ELEVENLABS_API_KEY"), 500

    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    voice_id = (body.get("voice_id") or DEFAULT_VOICE_ID).strip()

    if not text:
        return jsonify(error="'text' is required"), 400
    if len(text) > MAX_TEXT_LENGTH:
        return jsonify(error=f"'text' exceeds {MAX_TEXT_LENGTH} characters"), 400

    def generate():
        # Errors raised in here (bad voice_id, auth failure, etc.) surface after the
        # 200 response has already started streaming, since ElevenLabs doesn't fail
        # until the first chunk is pulled — the client just sees the stream cut short.
        audio_stream = client.text_to_speech.stream(
            voice_id=voice_id,
            text=text,
            model_id=DEFAULT_MODEL_ID,
            output_format="mp3_44100_128",
        )
        for chunk in audio_stream:
            if chunk:
                yield chunk

    return Response(generate(), mimetype="audio/mpeg")


if __name__ == "__main__":
    app.run(debug=True, port=5000)
