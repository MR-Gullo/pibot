# Pipi

A cute little smartphone robot that can talk to you, store memories about you, take photos, and drive around (provided you give it the legs of a [Octobot](https://robo.silverlit.com/products/octobot/))

## Development setup

Prerequisites:

- Node.js 22+
- Rust toolchain for native STT and optional native Qwen3-TTS workers
- Xcode command line tools, Xcode Metal Toolchain, CMake, pkg-config, and Opus for the Rust Qwen3-TTS MLX backend on Apple Silicon macOS
- `uv` available on `PATH` if you use the optional Python/MLX Qwen3-TTS worker
- `tar` available on `PATH` so Pipi can extract llama.cpp release archives

On Apple Silicon macOS, install the native build prerequisites first:

```bash
brew install cmake pkg-config opus
xcodebuild -downloadComponent MetalToolchain
```

Then install, build, and run:

```bash
npm install --ignore-scripts
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

On startup, Pipi connects to an existing OpenAI-compatible llama.cpp server at `http://127.0.0.1:8080/v1` if one is already running. Otherwise it downloads a pinned llama.cpp release binary into `~/.cache/pibot/llama.cpp`, downloads missing local LLM GGUF files, and starts `llama-server` automatically. The default local LLM is Qwen3.6 35B A3B. Set `LOCAL_LLM=gemma` to try the MoE model `ggml-org/gemma-4-26B-A4B-it-GGUF` instead.

Override paths/settings with:

```bash
LOCAL_LLM=qwen # or gemma
PIBOT_CACHE_DIR=/path/to/cache
LLAMA_BASE_URL=http://127.0.0.1:8080/v1
LLAMA_HOST=127.0.0.1
LLAMA_PORT=8080
LLAMA_CONTEXT_WINDOW=131072
LLAMA_MODEL_DIR=/path/to/model-dir
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

STT emits low-latency interim transcripts for stop-word detection. Interim decodes default to every `250ms`, start after `300ms` of speech, and decode only the most recent `4000ms` audio window. Override with `PARAKEET_INTERIM_INTERVAL_MS`, `PARAKEET_INTERIM_MIN_AUDIO_MS`, and `PARAKEET_INTERIM_WINDOW_MS`. Set `PARAKEET_INTERIM_INTERVAL_MS=0` to disable interims.

Model source: `istupakov/parakeet-tdt-0.6b-v3-onnx` on Hugging Face. Required files: `encoder-model.int8.onnx`, `decoder_joint-model.int8.onnx`, and `vocab.txt`.

## Qwen3-TTS worker

Default TTS uses the Rust Qwen3-TTS worker. The Rust worker binary defaults to `native/qwen3_tts_rs/target/release/worker`. The Rust model directory defaults to `~/models/qwen3-tts-12hz-0.6b-base` and is downloaded by the server on startup when missing. Override with `QWEN3_TTS_RUST_WORKER_PATH`, `QWEN3_TTS_RUST_MODEL_PATH`, and `QWEN3_TTS_RUST_MODEL_REPO` if needed.

To run dev mode with the optional Python/MLX worker:

```bash
QWEN3_TTS_WORKER=python npm run dev
```
