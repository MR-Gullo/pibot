# Pipi

A cute little smartphone robot that can talk to you, store memories about you, take photos, and drive around (provided you give it the legs of a [Octobot](https://robo.silverlit.com/products/octobot/))

## Run web demo

Prerequisites:

- Node.js 22+
- `uv` available on `PATH` so the server can spawn local speech sidecars:
  - Qwen3-TTS for local cloned-voice TTS
  - Parakeet MLX + Silero VAD for local STT

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:8010
```

For phone access, expose port `8010` via ngrok HTTPS.