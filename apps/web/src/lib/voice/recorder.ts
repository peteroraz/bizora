/**
 * Records from the microphone only while the person holds the recording open (ADR-040), for at most 30 seconds, and
 * turns it into 16 kHz mono samples for Whisper. The microphone is released as soon as recording stops. The sound
 * is kept in memory only; it is never saved or uploaded.
 */
export const MAX_SECONDS = 30;
const SAMPLE_RATE = 16_000;

export type Recording = {
  stop: () => Promise<Float32Array>;
  cancel: () => void;
  /** 0 to 1, for the moving bar while speaking. */
  level: () => number;
};

export async function startRecording(onAutoStop: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const meter = new Context();
  const analyser = meter.createAnalyser();
  analyser.fftSize = 256;
  meter.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.frequencyBinCount);
  const release = () => {
    stream.getTracks().forEach((track) => track.stop());
    void meter.close().catch(() => undefined);
  };
  const timer = window.setTimeout(onAutoStop, MAX_SECONDS * 1000);
  recorder.start();

  return {
    level() {
      analyser.getByteTimeDomainData(samples);
      let peak = 0;
      for (const value of samples) peak = Math.max(peak, Math.abs(value - 128));
      return Math.min(1, peak / 64);
    },
    cancel() {
      window.clearTimeout(timer);
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
    stop() {
      window.clearTimeout(timer);
      return new Promise<Float32Array>((resolve, reject) => {
        recorder.onstop = async () => {
          release();
          try {
            resolve(await decode(new Blob(chunks, { type: recorder.mimeType || "audio/webm" })));
          } catch (error) {
            reject(error);
          }
        };
        if (recorder.state !== "inactive") recorder.stop();
        else recorder.onstop?.(new Event("stop"));
      });
    },
  };
}

/** Any recorded or chosen audio file as 16 kHz mono samples. */
export async function decode(blob: Blob): Promise<Float32Array> {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Context({ sampleRate: SAMPLE_RATE });
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    if (audio.sampleRate === SAMPLE_RATE && audio.numberOfChannels === 1) return audio.getChannelData(0).slice();
    // Some browsers ignore the asked rate: mix down and resample.
    const offline = new OfflineAudioContext(1, Math.ceil(audio.duration * SAMPLE_RATE), SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    return (await offline.startRendering()).getChannelData(0).slice();
  } finally {
    void context.close().catch(() => undefined);
  }
}
