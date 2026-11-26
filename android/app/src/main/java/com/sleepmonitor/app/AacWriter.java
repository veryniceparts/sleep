package com.sleepmonitor.app;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Encodes 16 kHz mono PCM to an AAC .m4a file (32 kbit/s, ~14 MB per hour). */
class AacWriter {
    private static final String TAG = "AacWriter";
    final File file;
    final long startMs;
    long samples = 0;
    private final MediaCodec codec;
    private final MediaMuxer muxer;
    private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    private int track = -1;
    private boolean muxing = false;

    AacWriter(File file, long startMs) throws IOException {
        this.file = file;
        this.startMs = startMs;
        MediaFormat fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SleepService.RATE, 1);
        fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        fmt.setInteger(MediaFormat.KEY_BIT_RATE, 32000);
        fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
        MediaCodec c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        try {
            c.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            c.start();
            muxer = new MediaMuxer(file.getPath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        } catch (IOException | RuntimeException e) {
            // don't leak the encoder (a hardware resource) when the muxer or the codec setup fails
            try { c.stop(); } catch (Exception ignored) { }
            try { c.release(); } catch (Exception ignored) { }
            file.delete();
            throw e;
        }
        codec = c;
    }

    private long pts() { return samples * 1_000_000L / SleepService.RATE; }

    void write(short[] pcm, int n) {
        int off = 0, tries = 0;
        while (off < n) {
            int idx = codec.dequeueInputBuffer(10_000);
            if (idx < 0) {
                drain(false);
                if (++tries > 50) { Log.w(TAG, "encoder stalled, dropping audio"); return; }
                continue;
            }
            ByteBuffer b = codec.getInputBuffer(idx);
            b.clear();
            b.order(ByteOrder.LITTLE_ENDIAN);
            int count = Math.min(n - off, b.remaining() / 2);
            for (int i = 0; i < count; i++) b.putShort(pcm[off + i]);
            codec.queueInputBuffer(idx, 0, count * 2, pts(), 0);
            samples += count;
            off += count;
        }
        drain(false);
    }

    private void drain(boolean eos) {
        int idle = 0;
        while (true) {
            int idx = codec.dequeueOutputBuffer(info, eos ? 10_000 : 0);
            if (idx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!eos || ++idle > 200) return;
                continue;
            }
            if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                track = muxer.addTrack(codec.getOutputFormat());
                muxer.start();
                muxing = true;
                continue;
            }
            if (idx < 0) continue;
            ByteBuffer out = codec.getOutputBuffer(idx);
            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
            if (info.size > 0 && muxing && out != null) {
                out.position(info.offset);
                out.limit(info.offset + info.size);
                muxer.writeSampleData(track, out, info);
            }
            codec.releaseOutputBuffer(idx, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
        }
    }

    /**
     * Finishes the file and returns its size in bytes (0 if nothing was written). Can take a moment (drains the
     * encoder): SleepService calls it on its file thread, not on the audio thread. write() may throw
     * MediaCodec.CodecException / IllegalStateException; the caller handles that and still calls finish().
     */
    long finish() {
        try {
            int idx = codec.dequeueInputBuffer(100_000);
            if (idx >= 0) codec.queueInputBuffer(idx, 0, 0, pts(), MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            drain(true);
        } catch (Exception e) {
            Log.w(TAG, "finish drain failed", e);
        }
        try { codec.stop(); } catch (Exception ignored) { }
        try { codec.release(); } catch (Exception ignored) { }
        boolean ok = muxing;
        try { if (muxing) muxer.stop(); } catch (Exception e) { ok = false; Log.w(TAG, "muxer stop failed", e); }
        try { muxer.release(); } catch (Exception ignored) { }
        if (!ok) { file.delete(); return 0; }
        return file.length();
    }
}
