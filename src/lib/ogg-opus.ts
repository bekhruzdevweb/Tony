import OpusScript from "opusscript";

/**
 * WAV to OGG/Opus, the format Telegram shows as a voice bubble.
 *
 * The speech service returns WAV, and there is no ffmpeg on the server, so
 * this is done here: the samples are read from the WAV, encoded with libopus
 * (compiled to plain JavaScript), and wrapped in an Ogg stream by hand.
 */
const OPUS_RATES = [8000, 12000, 16000, 24000, 48000] as const;
const FRAME_MS = 20;
/** Samples the decoder should discard at the start; the conventional value for libopus. */
const PRE_SKIP = 3840;
const PACKETS_PER_PAGE = 50; // one second of audio per Ogg page

type Pcm = { samples: Int16Array; sampleRate: number; channels: number };

/** Reads 16-bit PCM out of a WAV file. Throws on anything else. */
export function readWav(bytes: Uint8Array): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");

  let format: { code: number; channels: number; sampleRate: number; bits: number } | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    // Streamed WAVs sometimes declare a size of 0 or 0xFFFFFFFF for the data; take what is there.
    const declared = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const size = Math.min(declared === 0xffffffff ? Infinity : declared, bytes.length - body);
    if (id === "fmt ") {
      format = {
        code: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new Error("WAV data before format");
      // 1 = PCM; 0xFFFE = "extensible", which for 16-bit audio is still PCM.
      if ((format.code !== 1 && format.code !== 0xfffe) || format.bits !== 16) throw new Error("only 16-bit PCM WAV is supported");
      if (format.channels < 1 || format.channels > 2) throw new Error("only mono or stereo WAV is supported");
      const length = id === "data" && declared === 0 ? bytes.length - body : size;
      const count = Math.floor(length / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(body + i * 2, true);
      return { samples, sampleRate: format.sampleRate, channels: format.channels };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no audio data");
}

/** Mixes stereo down to mono; a voice does not need two channels. */
function toMono(pcm: Pcm): Int16Array {
  if (pcm.channels === 1) return pcm.samples;
  const mono = new Int16Array(Math.floor(pcm.samples.length / 2));
  for (let i = 0; i < mono.length; i++) mono[i] = (pcm.samples[i * 2] + pcm.samples[i * 2 + 1]) >> 1;
  return mono;
}

/** Linear resampling, for the rare rate Opus does not take directly (22050, 44100). */
function resample(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return samples;
  const out = new Int16Array(Math.floor((samples.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const position = i * step;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    out[i] = Math.round(samples[left] + (samples[right] - samples[left]) * (position - left));
  }
  return out;
}

// Ogg's checksum: CRC-32 with polynomial 0x04c11db7, not reflected, starting at zero.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function crc(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = ((value << 8) ^ CRC_TABLE[((value >>> 24) ^ byte) & 0xff]) >>> 0;
  return value;
}

/** One Ogg page holding whole packets. */
function page(packets: Uint8Array[], options: { serial: number; sequence: number; granule: number; first?: boolean; last?: boolean }): Uint8Array {
  // Each packet is laced as a run of 255s ended by a value below 255.
  const lacing: number[] = [];
  for (const packet of packets) {
    let left = packet.length;
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    lacing.push(left);
  }
  const bodySize = packets.reduce((sum, packet) => sum + packet.length, 0);
  const out = new Uint8Array(27 + lacing.length + bodySize);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  out[4] = 0; // stream structure version
  out[5] = (options.first ? 0x02 : 0) | (options.last ? 0x04 : 0);
  view.setUint32(6, options.granule >>> 0, true);
  view.setUint32(10, Math.floor(options.granule / 0x100000000), true);
  view.setUint32(14, options.serial, true);
  view.setUint32(18, options.sequence, true);
  view.setUint32(22, 0, true); // checksum, filled in below
  out[26] = lacing.length;
  out.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) {
    out.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, crc(out), true);
  return out;
}

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** WAV bytes in, OGG/Opus bytes out (mono, voice-tuned). */
export function wavToOggOpus(wav: Uint8Array): Uint8Array {
  const pcm = readWav(wav);
  let samples = toMono(pcm);
  let rate = pcm.sampleRate;
  if (!(OPUS_RATES as readonly number[]).includes(rate)) {
    samples = resample(samples, rate, 48000);
    rate = 48000;
  }

  // The plain-JavaScript build: nothing to load from disk, so it runs anywhere.
  const encoder = new OpusScript(rate as (typeof OPUS_RATES)[number], 1, OpusScript.Application.VOIP, { wasm: false });
  try {
    encoder.setBitrate(32000);
    const frameSize = (rate * FRAME_MS) / 1000;
    const packets: Uint8Array[] = [];
    for (let start = 0; start < samples.length; start += frameSize) {
      // The last frame is padded with silence to full length.
      const frame = new Int16Array(frameSize);
      frame.set(samples.subarray(start, Math.min(start + frameSize, samples.length)));
      const encoded = encoder.encode(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), frameSize);
      packets.push(Uint8Array.from(encoded));
    }

    const serial = (Math.random() * 0xffffffff) >>> 0;
    const head = new Uint8Array(19);
    head.set(ascii("OpusHead"));
    const headView = new DataView(head.buffer);
    head[8] = 1; // version
    head[9] = 1; // channels
    headView.setUint16(10, PRE_SKIP, true);
    headView.setUint32(12, pcm.sampleRate, true); // the original rate, for information only
    headView.setUint16(16, 0, true); // output gain
    head[18] = 0; // channel mapping: mono or stereo

    const vendor = ascii("Tony");
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set(ascii("OpusTags"));
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);

    const pages: Uint8Array[] = [page([head], { serial, sequence: 0, granule: 0, first: true }), page([tags], { serial, sequence: 1, granule: 0 })];
    // Positions in an Opus stream are always counted at 48 kHz, whatever the input rate.
    const perPacket = (48000 * FRAME_MS) / 1000;
    const totalSamples = PRE_SKIP + Math.round((samples.length * 48000) / rate);
    let sequence = 2;
    for (let i = 0; i < packets.length; i += PACKETS_PER_PAGE) {
      const group = packets.slice(i, i + PACKETS_PER_PAGE);
      const last = i + PACKETS_PER_PAGE >= packets.length;
      // The final position marks where the real audio ends, trimming the padding.
      const granule = last ? totalSamples : (i + group.length) * perPacket;
      pages.push(page(group, { serial, sequence: sequence++, granule, last }));
    }

    const out = new Uint8Array(pages.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const p of pages) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  } finally {
    encoder.delete();
  }
}
