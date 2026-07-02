#!/usr/bin/env python3
from __future__ import annotations

import argparse
import struct
import sys
from contextlib import redirect_stdout
from typing import Any

import numpy as np

WORKER_INPUT_SPEAK = 1
WORKER_INPUT_SHUTDOWN = 3
WORKER_OUTPUT_READY = 1
WORKER_OUTPUT_AUDIO_START = 2
WORKER_OUTPUT_AUDIO_CHUNK = 3
WORKER_OUTPUT_AUDIO_DONE = 4
WORKER_OUTPUT_ERROR = 5
FRAME_HEADER = struct.Struct("<BII")
STDOUT_BUFFER = sys.stdout.buffer


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def read_exact(length: int) -> bytes | None:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = sys.stdin.buffer.read(length - len(chunks))
        if not chunk:
            return None
        chunks.extend(chunk)
    return bytes(chunks)


def read_frame() -> tuple[int, int, bytes] | None:
    header = read_exact(FRAME_HEADER.size)
    if header is None:
        return None
    frame_type, request_id, payload_len = FRAME_HEADER.unpack(header)
    payload = read_exact(payload_len)
    if payload is None:
        return None
    return frame_type, request_id, payload


def write_frame(frame_type: int, request_id: int, payload: bytes = b"") -> None:
    STDOUT_BUFFER.write(FRAME_HEADER.pack(frame_type, request_id & 0xFFFFFFFF, len(payload)))
    STDOUT_BUFFER.write(payload)
    STDOUT_BUFFER.flush()


def to_int16(audio: np.ndarray) -> np.ndarray:
    return np.clip(audio * 32768, -32768, 32767).astype(np.int16)


def iter_pcm_chunks(audio: np.ndarray, blocksize: int) -> list[np.ndarray]:
    if len(audio) == 0:
        return []
    chunks = []
    for start in range(0, len(audio), blocksize):
        chunk = audio[start : start + blocksize]
        if len(chunk) < blocksize:
            chunk = np.pad(chunk, (0, blocksize - len(chunk)))
        chunks.append(chunk)
    return chunks


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--repo-id", default="hexgrad/Kokoro-82M")
    parser.add_argument("--lang-code", default="z")
    parser.add_argument("--voice", default="zm_yunjian")
    parser.add_argument("--speed", type=float, default=0.9)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output-sample-rate", type=int, default=24000)
    parser.add_argument("--blocksize", type=int, default=24000)
    return parser.parse_args()


def load_pipeline(args: argparse.Namespace) -> Any:
    with redirect_stdout(sys.stderr):
        from kokoro import KPipeline

        return KPipeline(lang_code=args.lang_code, repo_id=args.repo_id, device=args.device)


def synthesize_text(pipeline: Any, args: argparse.Namespace, text: str) -> np.ndarray:
    chunks = []
    with redirect_stdout(sys.stderr):
        for _graphemes, _phonemes, audio in pipeline(text, voice=args.voice, speed=args.speed):
            chunks.append(np.asarray(audio, dtype=np.float32).squeeze())
    if not chunks:
        return np.array([], dtype=np.int16)
    return to_int16(np.concatenate(chunks))


def handle_speak(pipeline: Any, args: argparse.Namespace, request_id: int, payload: bytes) -> None:
    text = payload.decode("utf-8").strip()
    if not text:
        write_frame(WORKER_OUTPUT_AUDIO_DONE, request_id)
        return
    try:
        log(f"Kokoro synth request id={request_id} voice={args.voice} chars={len(text)}")
        pcm = synthesize_text(pipeline, args, text)
        write_frame(WORKER_OUTPUT_AUDIO_START, request_id, struct.pack("<I", args.output_sample_rate))
        for chunk in iter_pcm_chunks(pcm, max(1, args.blocksize)):
            write_frame(WORKER_OUTPUT_AUDIO_CHUNK, request_id, chunk.tobytes())
        write_frame(WORKER_OUTPUT_AUDIO_DONE, request_id)
        log(f"Kokoro synth done id={request_id} samples={len(pcm)}")
    except Exception as error:
        write_frame(WORKER_OUTPUT_ERROR, request_id, str(error).encode("utf-8"))
        log(f"Kokoro synth error id={request_id}: {error}")


def main() -> int:
    args = parse_args()
    if not args.serve:
        raise SystemExit("--serve is required")
    log(f"loading Kokoro repo={args.repo_id} lang={args.lang_code} voice={args.voice} device={args.device}")
    pipeline = load_pipeline(args)
    write_frame(WORKER_OUTPUT_READY, 0)
    log("ready")
    while True:
        frame = read_frame()
        if frame is None:
            return 0
        frame_type, request_id, payload = frame
        if frame_type == WORKER_INPUT_SHUTDOWN:
            return 0
        if frame_type == WORKER_INPUT_SPEAK:
            handle_speak(pipeline, args, request_id, payload)


if __name__ == "__main__":
    raise SystemExit(main())
