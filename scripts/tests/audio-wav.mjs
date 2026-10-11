// Generate a real, valid PCM WAV fixture with a deterministic 440 Hz tone.
// It is intentionally small so Web Audio can decode and draw its actual samples.
export function makeToneWav({durationSeconds = 0.8, sampleRate = 16_000, frequency = 440, amplitudeModulationHz = 0} = {}) {
  const channels = 1, bitsPerSample = 16;
  const frames = Math.floor(durationSeconds * sampleRate);
  const dataBytes = frames * channels * bitsPerSample / 8;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  wav.writeUInt16LE(channels * bitsPerSample / 8, 32); wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    // A short fade-in/out avoids clicks while retaining measurable amplitude.
    const fade = Math.min(1, i / 320, (frames - 1 - i) / 320);
    const modulation = amplitudeModulationHz > 0 ? 0.06 + 0.94 * (0.5 + 0.5 * Math.sin(2 * Math.PI * amplitudeModulationHz * i / sampleRate)) : 1;
    const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 0.72 * Math.max(0, fade) * modulation;
    wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return wav;
}

export function makeSilenceWav({durationSeconds = 0.8, sampleRate = 16_000} = {}) {
  const tone = makeToneWav({durationSeconds, sampleRate, frequency: 440});
  tone.fill(0, 44);
  return tone;
}
