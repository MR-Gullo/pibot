# Phone Robot Agent Demo

Android phone as robot face/camera/mic/speaker; Node server runs the LLM agent; FT232H/WebUSB motor control is separate for now.

## Run web demo

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:8010
```

For phone access, expose port `8010` via ngrok HTTPS.

## STT/TTS direction

Browser Web Speech on Android is unreliable: it ends sessions after ~5s and fights TTS/audio focus.

Current investigation:

- STT: Kyutai/Moshi streaming STT looks promising; official model is EN/FR, German works unofficially in the live demo.
- TTS: Kyutai Pocket TTS supports German locally on CPU and has a working `/tts` server endpoint.

Whisper/WhisperLiveKit experiments were removed.

## Current tools

- `move_forward`
- `turn_left` / counter-clockwise rotate
- `stop`
- `take_photo`
- `memory`
