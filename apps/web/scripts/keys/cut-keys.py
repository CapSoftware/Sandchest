"""
The hacker's keyboard sounds: single keystrokes cut from public-domain (CC0)
typing recordings on Freesound, one keyboard per style, written as one small
WAV per style (apps/web/public/keys/<style>.wav) and the takes' places in it
(printed, for TAKES in src/components/hacker/switches.ts).

    python3 apps/web/scripts/keys/cut-keys.py /tmp/keys apps/web/public/keys

The first argument is a folder of the source recordings, named <sound id>.mp3
(Freesound's high-quality previews: https://freesound.org/s/<sound id>/).

Every strike in a recording is found by its onset (a sharp rise in loudness
over a few milliseconds). Only strikes with nothing else for a while after
them are kept, so each take is one key, its own release and nothing more;
of those, a varied set near the recording's typical loudness. The deepest
(lowest spectral centroid) are kept apart for wide keys like the space bar.
Each take is levelled to the same loudness and faded at its end.
"""

import json
import os
import subprocess
import sys
import wave

import numpy as np

RATE = 44100
STYLES = {
    # A MacBook Pro's keyboard.
    "laptop": {"source": 565645, "length": 0.11, "takes": 10},
    # Cherry MX Brown tactile switches.
    "tactile": {"source": 400167, "length": 0.12, "takes": 10},
    # A Rainy 75: a heavy aluminium board, deep and round.
    "thock": {"source": 815614, "length": 0.12, "takes": 10},
    # Cherry MX Blue click-jacket switches.
    "clicky": {"source": 382057, "length": 0.12, "takes": 10},
    # An Olivetti Lettera 22 typewriter.
    "typewriter": {"source": 123344, "length": 0.2, "takes": 10},
}
WIDE = 3
# Loudness every take is levelled to (RMS over its first 40 ms), in full scale.
LEVEL = 0.065


def decode(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def onsets(x):
    """Sample indices where a strike starts: energy in 2 ms frames jumping well above the 30 ms before."""
    frame = int(RATE * 0.002)
    n = len(x) // frame
    energy = (x[: n * frame].reshape(n, frame) ** 2).mean(axis=1) + 1e-12
    db = 10 * np.log10(energy)
    floor = np.percentile(db, 30)
    found = []
    last = -1000
    for i in range(15, n - 2):
        before = db[i - 15 : i - 1].min()
        if db[i] - before > 14 and db[i] > floor + 18 and db[i] >= db[i + 1] - 3 and i - last > 30:
            # Back to where it first rises: a tenth of this frame's peak, a millisecond early.
            start = (i - 1) * frame
            peak = np.abs(x[start : start + 3 * frame]).max()
            rise = np.argmax(np.abs(x[start : start + 3 * frame]) > peak * 0.1)
            found.append(max(0, start + rise - int(RATE * 0.001)))
            last = i
    return found


def centroid(clip):
    spectrum = np.abs(np.fft.rfft(clip * np.hanning(len(clip))))
    freqs = np.fft.rfftfreq(len(clip), 1 / RATE)
    return float((spectrum * freqs).sum() / (spectrum.sum() + 1e-12))


def cut(x, style):
    length = int(RATE * style["length"])
    starts = onsets(x)
    clips = []
    for start in starts:
        clip = x[start : start + length].copy()
        if len(clip) < length or start < int(RATE * 0.03):
            continue
        level = np.abs(clip)
        head = clip[: int(RATE * 0.025)]
        hit = float(level[: int(RATE * 0.025)].max())
        pre = x[start - int(RATE * 0.03) : start]
        # One clean strike: loudest at its very start (not a faint sound before the real one), nothing after it
        # louder than 40% of it (its own release is quieter), and quiet just before it.
        if np.argmax(level) > int(RATE * 0.008):
            continue
        if level[int(RATE * 0.03) :].max() > hit * 0.4:
            continue
        if np.sqrt((pre**2).mean()) > np.sqrt((head**2).mean()) * 0.2:
            continue
        clips.append({"clip": clip, "peak": float(level.max()), "rms": float(np.sqrt((clip[: int(RATE * 0.04)] ** 2).mean())), "centroid": centroid(clip)})
    print(f"  {style['source']}: {len(starts)} strikes, {len(clips)} clean", file=sys.stderr)
    if len(clips) < style["takes"] + WIDE:
        raise SystemExit(f"{style['source']}: only {len(clips)} clean strikes")
    # Typical strikes: the middle of the loudness range, then spread across it.
    clips.sort(key=lambda c: c["rms"])
    middle = clips[len(clips) // 5 : len(clips) - len(clips) // 5]
    wide = sorted(middle, key=lambda c: c["centroid"])[:WIDE]
    rest = [c for c in middle if all(c is not w for w in wide)]
    step = len(rest) / style["takes"]
    keys = [rest[int(i * step)] for i in range(style["takes"])]
    return keys, wide, len(starts), len(clips)


def finish(clip):
    """Levelled, a hair of fade in and a gentle fade out."""
    head = clip[: int(RATE * 0.04)]
    clip = clip * (LEVEL / max(1e-6, np.sqrt((head**2).mean())))
    fade_in = int(RATE * 0.0005)
    fade_out = int(RATE * 0.03)
    clip[:fade_in] *= np.linspace(0, 1, fade_in)
    clip[-fade_out:] *= np.linspace(1, 0, fade_out) ** 2
    return clip


def main():
    sources, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    takes = {}
    for name, style in STYLES.items():
        x = decode(os.path.join(sources, f"{style['source']}.mp3"))
        keys, wide, found, clean = cut(x, style)
        gap = np.zeros(int(RATE * 0.01))
        parts, places, at = [], {"keys": [], "wide": []}, 0
        for group, clips in (("keys", keys), ("wide", wide)):
            for c in clips:
                clip = finish(c["clip"])
                places[group].append([round(at / RATE, 4), round(len(clip) / RATE, 4)])
                parts += [clip, gap]
                at += len(clip) + len(gap)
        audio = np.concatenate(parts)
        peak = np.abs(audio).max()
        if peak > 0.99:
            audio *= 0.99 / peak
        with wave.open(os.path.join(out, f"{name}.wav"), "wb") as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(RATE)
            f.writeframes((audio * 32767).astype("<i2").tobytes())
        takes[name] = places
        print(f"{name}: {found} strikes, {clean} clean, kept {len(keys)} + {len(wide)} wide, peak {peak:.2f}", file=sys.stderr)
    print(json.dumps(takes))


main()
