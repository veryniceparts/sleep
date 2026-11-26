package com.sleepmonitor.app;

import android.content.res.AssetManager;

import org.tensorflow.lite.Interpreter;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.zip.Inflater;

/**
 * Google's YAMNet sound-event model (521 classes), run with the TensorFlow Lite (LiteRT) interpreter.
 * Uses the same model file the web app uses (bundled at assets/public/vendor/yamnet.tflite); the file is
 * also a zip archive holding the label list.
 */
final class YamnetModel implements SoundRecognizer.Model {
    static final String ASSET = "public/vendor/yamnet.tflite";
    private static final String LABELS = "yamnet_label_list.txt";

    private final Interpreter tfl;
    private final String[] labels;
    private final float[][] out;

    private YamnetModel(Interpreter tfl, String[] labels) {
        this.tfl = tfl;
        this.labels = labels;
        this.out = new float[1][labels.length];
    }

    static YamnetModel load(AssetManager assets) throws IOException {
        byte[] bytes;
        try (InputStream in = assets.open(ASSET)) { bytes = readAll(in); }
        String[] labels = readLabels(bytes);
        // the interpreter needs the model in a direct buffer that stays untouched while it is used
        ByteBuffer buf = ByteBuffer.allocateDirect(bytes.length).order(ByteOrder.nativeOrder());
        buf.put(bytes);
        buf.rewind();
        Interpreter.Options opt = new Interpreter.Options();
        opt.setNumThreads(1); // modest CPU use: it runs all night next to the recording
        Interpreter tfl = new Interpreter(buf, opt);
        try {
            int[] inShape = tfl.getInputTensor(0).shape(), outShape = tfl.getOutputTensor(0).shape();
            if (inShape.length != 1 || inShape[0] != SoundRecognizer.WIN || outShape.length != 2
                    || outShape[0] != 1 || outShape[1] != labels.length) {
                throw new IOException("unexpected model shape " + Arrays.toString(inShape) + " -> " + Arrays.toString(outShape));
            }
        } catch (IOException | RuntimeException e) {
            tfl.close();
            throw e;
        }
        return new YamnetModel(tfl, labels);
    }

    @Override public String[] labels() { return labels; }

    @Override
    public float[] classify(float[] window) {
        tfl.run(window, out);
        return out[0];
    }

    @Override public void close() { tfl.close(); }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(1 << 22);
        byte[] tmp = new byte[1 << 16];
        int n;
        while ((n = in.read(tmp)) > 0) b.write(tmp, 0, n);
        return b.toByteArray();
    }

    /** The label list stored in the zip archive appended to the model file (one label per line). */
    static String[] readLabels(byte[] f) throws IOException {
        // end of central directory record: the last "PK\5\6" signature
        int eocd = -1;
        for (int i = f.length - 22; i >= Math.max(0, f.length - 22 - 65535); i--) {
            if (u32(f, i) == 0x06054b50L) { eocd = i; break; }
        }
        if (eocd < 0) throw new IOException("no label list in the model");
        int count = u16(f, eocd + 10);
        long cdSize = u32(f, eocd + 12), cdOffset = u32(f, eocd + 16);
        int cd = (int) (eocd - cdSize);
        long shift = cd - cdOffset; // the archive may sit after the model with offsets relative to its own start
        for (int e = 0, p = cd; e < count && p + 46 <= f.length; e++) {
            if (u32(f, p) != 0x02014b50L) break;
            int method = u16(f, p + 10);
            long compSize = u32(f, p + 20), size = u32(f, p + 24);
            int nameLen = u16(f, p + 28), extraLen = u16(f, p + 30), commentLen = u16(f, p + 32);
            long local = u32(f, p + 42) + shift;
            String name = new String(f, p + 46, nameLen, StandardCharsets.UTF_8);
            p += 46 + nameLen + extraLen + commentLen;
            if (!name.endsWith(LABELS)) continue;
            int lp = (int) local;
            if (lp < 0 || lp + 30 > f.length || u32(f, lp) != 0x04034b50L) throw new IOException("bad label entry");
            int data = lp + 30 + u16(f, lp + 26) + u16(f, lp + 28);
            byte[] txt;
            if (method == 0) {
                txt = Arrays.copyOfRange(f, data, (int) (data + size));
            } else if (method == 8) {
                Inflater inf = new Inflater(true);
                inf.setInput(f, data, (int) compSize);
                txt = new byte[(int) size];
                try { inf.inflate(txt); } catch (java.util.zip.DataFormatException x) { throw new IOException(x); } finally { inf.end(); }
            } else throw new IOException("unsupported compression " + method);
            String[] lines = new String(txt, StandardCharsets.UTF_8).split("\r?\n");
            int n = lines.length;
            while (n > 0 && lines[n - 1].trim().isEmpty()) n--;
            String[] out = new String[n];
            for (int i = 0; i < n; i++) out[i] = lines[i].trim();
            return out;
        }
        throw new IOException("no label list in the model");
    }

    private static int u16(byte[] b, int i) { return (b[i] & 0xff) | (b[i + 1] & 0xff) << 8; }

    private static long u32(byte[] b, int i) { return (u16(b, i) | (long) u16(b, i + 2) << 16) & 0xffffffffL; }
}
