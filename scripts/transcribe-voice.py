"""Decode a bounded, local QQ voice clip and transcribe it on this machine."""
import json
import os
import subprocess
import sys

import numpy as np
import torch
import whisper

MAX_SECONDS = 600
SAMPLE_RATE = 16000
clip = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
if not clip or len(clip) > 16 * 1024 * 1024:
    raise ValueError("Invalid voice size")
# Pipe input disallows nested network or file access by playlist demuxers.
decoded = subprocess.run([
    "/usr/bin/ffmpeg", "-v", "error", "-nostdin", "-protocol_whitelist", "pipe",
    "-i", "pipe:0", "-t", str(MAX_SECONDS + 1), "-ac", "1", "-ar", str(SAMPLE_RATE),
    "-f", "s16le", "pipe:1"
], input=clip, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=True)
samples = np.frombuffer(decoded.stdout, np.int16)
if not 0 < samples.size <= MAX_SECONDS * SAMPLE_RATE:
    raise ValueError("Voice duration outside transcription limit")
torch.set_num_threads(2)
model = whisper.load_model(os.path.expanduser("~/.cache/whisper/base.pt"), device="cpu")
result = model.transcribe(samples.astype(np.float32) / 32768.0, fp16=False, temperature=0,
                          condition_on_previous_text=False, verbose=None)
print(json.dumps({"text": result["text"].strip()}))
