# Pipi

A cute little smartphone robot that can talk to you, store memories about you, take photos, and drive around (provided you give it the legs of a [Octobot](https://robo.silverlit.com/products/octobot/))

## Run web demo

Prerequisites:

- Node.js 22+
- Rust toolchain for native STT and optional native Qwen3-TTS workers
- `uv` available on `PATH` if you use the default Python/MLX Qwen3-TTS worker
- `tar` available on `PATH` so Pipi can extract llama.cpp release archives

```bash
npm install
npm run submodules
npm run build:native
npm run dev
```

Open:

```text
http://localhost:8010
```

For phone access, expose port `8010` via ngrok HTTPS.

## Local LLM

On startup, Pipi connects to an existing OpenAI-compatible llama.cpp server at `http://127.0.0.1:8080/v1` if one is already running. Otherwise it downloads a pinned llama.cpp release binary into `~/.cache/pibot/llama.cpp`, downloads missing Qwen3.6 35B A3B GGUF files into `~/models/qwen3.6-35b-a3b`, and starts `llama-server` automatically.

Override paths/settings with:

```bash
PIBOT_CACHE_DIR=/path/to/cache
LLAMA_BASE_URL=http://127.0.0.1:8080/v1
LLAMA_HOST=127.0.0.1
LLAMA_PORT=8080
LLAMA_CONTEXT_WINDOW=131072
LLAMA_MODEL_DIR=/path/to/qwen3.6-35b-a3b
```

## Native workers

Build both native workers:

```bash
npm run build:native
```

Build only STT:

```bash
npm run build:stt-rust
```

Build only the Rust Qwen3-TTS worker submodule:

```bash
npm run build:tts-rust
```

The server uses the Rust STT worker automatically. On startup, Pipi downloads missing Parakeet TDT int8 ONNX files from Hugging Face into `~/models/parakeet-tdt-0.6b-v3-onnx-int8`. Set `PARAKEET_TDT_MODEL_DIR` to use a different location.

Model source: `istupakov/parakeet-tdt-0.6b-v3-onnx` on Hugging Face. Required files: `encoder-model.int8.onnx`, `decoder_joint-model.int8.onnx`, and `vocab.txt`.

## Qwen3-TTS worker

Default TTS uses the Python/MLX worker in `scripts/qwen3-tts-worker.py`.

To run dev mode with the Rust Qwen3-TTS worker:

```bash
QWEN3_TTS_WORKER=rust npm run dev
```

The Rust worker binary defaults to `native/qwen3_tts_rs/target/release/worker`. The Rust model directory defaults to `~/models/qwen3-tts-12hz-0.6b-base`. Override with `QWEN3_TTS_RUST_WORKER_PATH` and `QWEN3_TTS_RUST_MODEL_PATH` if needed.
